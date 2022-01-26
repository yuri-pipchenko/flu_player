const log_error = (...args)   => log('ERROR', ...args);
const log_warning = (...args) => log('WARNING', ...args);
const log_info = (...args)    => log('INFO', ...args);
const log_debug = (...args)   => log('DEBUG', ...args);

const log = (level, ...args) => {
  console.log('[Flu Player] ' + level + ':', ...args);
}

export {log_error, log_warning, log_info, log_debug};
