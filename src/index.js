import {log_error, log_warning, log_info, log_debug} from './logger';

/*
 API:
 - play()
 - pause()
 - seek(UTC)
 - setRate(Rate)
 - stop()
 - rate() - returns current playback rate
 - time() - returns current playback time
*/

class FluPlayer {
    constructor(props) {
        this.media = props.media;
        this.url = props.url;
        this.curTime = props.time;
        this.videoTrack = props.videoTrack;
        this.audioTack = props.audioTack;
        this.buffers = [];
        this.paused = true;   // media playback state
        this.open = false;    // websocket state, true if it's connected.
        this.loading = false; // buffers loading state, true - data downloading is in progress.
        this.live = true;     // true if realtime video (with minimum delay) is displaying
        this.waitingData = true;
        this.onProgress = props.onProgress || (() => {});
        this.onPlay     = props.onPlay || (() => {});
        this.onPause    = props.onPause || (() => {});
        this.media.addEventListener('timeupdate', event => {
            props.onProgress(this.time());
        });
        this.media.addEventListener('ratechange', event => {
            this.live = event.target.playbackRate === 1.0;
        });
        this.media.addEventListener('pause', this._onMediaPause);
        this.media.addEventListener('play', this._onMediaPlay);
    }

    play = () => {
        return this.media.play();
    }

    pause = () => {
        return this.media.pause();
    }

    seek = utc => {
        log_debug('seek to utc:', utc);
        /* place media element to last buffered time to prevent delay of
           new video displaying (acts like buffers clearing) */
        const end_time = this._videoEndTime();
        if (end_time) {
            this.media.currentTime = end_time;
        }
        if (utc === 'live') {
            this.media.playbackRate = 1.0;
            this.live = true;
        } else {
            this.curTime = utc;
            this.live = false;
        }
        this._doSeek(utc);
    }

    rate = () => {
        return this.media.playbackRatel;
    }

    setRate = rate => {
        log_info("set playback rate:", rate);
        this.media.playbackRate = rate;
    }

    time = () => {
        /* media currentTime started from 0 !!! when the page is created */
        return this.media.currentTime + this.timeShift;
    }

    stop = () => {
        log_info("stoping");
        this.pause();
        this.ws.close();
        this.ms.endOfStream();
    }

    setURL = URL => {
	log_info("set stream URL:", URL);
	this.url = URL;
        const end_time = this._videoEndTime();
        if (end_time) {
	    this.media.currentTime = end_time;
        }
	if (this.ws) {
	    this.ws.close(); //connection will be restored in close event handler
	}
    }

    _onMediaPlay = () => {
        log_info('play event from media component, url:', this.url, "time:", this.curTime, "video:", this.videoTrack, "audio:", this.audioTack);
        if (!this.paused) {
            return;
        }
        this.onPlay(); //event to owner
        this.paused = false;
        if (this.open) {
            log_debug('web socket is open, resume downloading data');
            this._doSeek(this.curTime - 4); // Flussonic doesn't return exact position as in the request
            this._doResume();
        } else {
	    this._connect();
        }
    }

    _onMediaPause = () => {
        log_info("pause event from media")
        this.onPause();
        this.live = false;
        this.paused = true;
        this._doPause();
    };

    _connect = () => {
        log_info('opening web socket, URL:', this.url);
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => {
            log_info("web socket is open");
            this.open = true;
            this._doResume();
        };
        this.ws.onclose = () => {
            log_info("web socket is closed");
	    this.open = false;
	    this.loading = false;
            this._stopTimer();
            if (!this.paused) {
		this._connect();
            }
        };
        this.ws.onerror = err => {
            log_error("web socket error: ", err);
        };
        this.ws.onmessage = this._onMessage;
        this.waitingStart = true; // waitinig for first media segment

    };

    _onMessage = msg => {
        if (!msg.data) {
            log_warning('web socket message with unknown format (no message.data field) ');
            return;
        }
        if (msg.data instanceof ArrayBuffer) {
            if (this.waitingData) {
                this._recvMedia(msg.data);
            }
        } else {
            const data = JSON.parse(msg.data);
            switch (data.type) {
            case 'event':
                this._recvEvent(data.event);
                break;
            case 'mse_init_segment':
                this._recvInit(data);
                break;
            default:
                log_warning('unhandled web socket message with type:', data.type);
            }
        }
    }

    _recvInit = data => {
        log_info('received init segment:', data);
        this._clearBuffers();
        this.ms = new MediaSource();
        this.media.src = URL.createObjectURL(this.ms);
        this.ms.addEventListener('sourceopen', () => {
            log_debug("media source open");
            data.metadata.tracks.forEach(track => {
                const type = mimeType(track.content);
                const buf = this.ms.addSourceBuffer(type);
                this._initBuffer(buf, track.content, data.tracks);
            })
            this.media.play();
        })
    }

    _clearBuffers = () => {
        for (const idx in this.buffers) {
            const buf = this.buffers[idx];
            log_debug("clearing buffer, id:", idx);
            buf.abort();
            buf.removeEventListener('updateend', this._onBufUpdateEnd);
            if (this.ms) {
                this.ms.removeSourceBuffer(buf);
            }
        }
        this.buffers = [];
    }

    _initBuffer = (buf, content, tracks) => {
        for (const track of tracks) {
            if (track.content === content) {
                log_debug("buffer initialized, type:", content, ", track id:", track.id);
                this.buffers[track.id] = buf;
                buf.mode = 'sequence';
                buf.isVideo = content === 'video';
                buf.segments = [];
                const ab = base64ToArrayBuffer(track.payload);
                buf.appendBuffer(ab);
                buf.addEventListener('updateend', this._onBufUpdateEnd);
                break;
            }
        }
    }

    _recvMedia = raw => {
        const segment = rawDataToSegment(raw);
        const buf = this.buffers[segment.id];
        if (!buf) {
            return;
        }
        const moment = getRealUtc(segment.data);
        if (moment <= this.curTime) {
            log_debug("skip segment with small pts");
            return;
        }
        buf.segments.push(segment);
        if (buf.isVideo) {
            this.curTime = moment;
            if (this.waitingStart) {
                log_debug('start segment received, segment time:', moment);
                this.waitingStart = false;
                this.timeShift = moment - this.media.currentTime; //segment timestamp minus video element time (which started from 0)
            }
        }
        if (buf.segments.length === 1) {
            this._onBufUpdateEnd({target: buf});
        }
    }

    _recvEvent = event => {
        log_info('event from flussonic:', event);
        this.waitingData = true; // response on sent command is received
        this.waitingStart = true;
        this._startTimer();
    }

    _onBufUpdateEnd = event => {
        const buf = event.target;
        if (buf.updating)
            return;
        if (buf.segments.length === 0)
            return;
        const segment = buf.segments.shift();
        buf.appendBuffer(segment.data);
    }

    _doPause = () => {
        if (this.open && this.loading) {
            this.live = false;
            this.loading = false;
            this._send('pause');
        }
    }

    _doResume = () => {
        if (this.open && !this.loading) {
            this.loading = true;
            this._send('resume');
        }
    }

    _doSeek = (utc) => {
        var cmd;
        if (this.live || utc === 'live') {
            cmd = 'live';
        } else {
            cmd = 'play_from=' + Math.round(utc); // parseInt(utc, 10);
        }
        this._send(cmd);
    }

    _send = cmd => {
        log_debug('sendind command:', cmd);
	if (!this.ws || !this.open) {
	    log_warning('command is not sent because web socket is not open');
	    return;
	}
        this.ws.send(cmd);
        this.waitingData = false; // ignore data segments before response event is received
        this._stopTimer();
    }

    _videoBuffer = () => {
        for (const idx in this.buffers) {
            const buf = this.buffers[idx];
            if (buf.isVideo) {
                return buf;
            }
        }
        return null;
    }

    _videoEndTime = () => {
        const buf = this._videoBuffer();
        if (!buf || !buf.buffered) {
            return null;
        }
        const ranges = buf.buffered;
        if (ranges.length === 0) {
            return null;
        }
        return ranges.end(ranges.length - 1); // finish time of last time range
    }

    _startTimer = () => {
        this.timer = setInterval(this._onTimer, 1000);
    }

    _stopTimer = () => {
        clearInterval(this.timer);
    }

    _onTimer = () => {
        const end_time = this._videoEndTime();
        if (!end_time) {
            return;
        }
        const cur_time = this.media.currentTime;
        const delta = end_time - cur_time; // size of buffered media data
        /* flow control - pause/resume downloading depending on buffer's current size */
        if (delta > 10.0 && this.loading) {
            this._doPause()
        }
        if (delta < 5.0 && !this.loading) {
            this._doSeek(this.curTime - 6);
            this._doResume();
        }
        /* minimize delay from real time in LIVE mode */
        if (this.live && delta > 1.5)   {
            this.media.currentTime = end_time - 0.5;
        }
    }
}

const mimeType = content => {
    switch (content) {
    case 'video':
        return 'video/mp4; codecs="avc1.4d401f"';
    case 'audio':
        return 'audio/mp4; codecs="mp4a.40.2"';
    default:
        return 'unknown';
    }
}

const rawDataToSegment = data => {
    const view = new Uint8Array(data);
    const trackId = view[47];
    return {id: trackId, data: view};
}

const getRealUtc = view => {
    const pts1 = (view[92] << 24) | (view[93] << 16) | (view[94] << 8) | view[95];
    const pts2 = (view[96] << 24) | (view[97] << 16) | (view[98] << 8) | view[99];
    const realUtc = pts1 + pts2 / 1000000;
    return realUtc;
}

const base64ToArrayBuffer = base64 => {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

export default FluPlayer;
