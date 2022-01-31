const log_error = (...args)   => log('ERROR', ...args);
const log_warning = (...args) => log('WARNING', ...args);
const log_info = (...args)    => log('INFO', ...args);
const log_debug = (...args)   => log('DEBUG', ...args);

const log = (level, ...args) => {
  console.log('[Flu Player] ' + level + ':', ...args);
}
