'use strict';
const path = require('node:path');
function absolute(value, paths = path) {
  if (typeof value !== 'string' || !paths.isAbsolute(value) || value.includes('\0')) throw new Error('An absolute file path is required');
  return paths.normalize(value);
}
const remoteAbsolute = value => absolute(value, path.posix);
function filename(name, platform = process.platform) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) throw new Error('Invalid file name');
  // Prevent Windows device names, alternate data streams and silently trimmed names.
  if (platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) throw new Error('File name is not supported on Windows: ' + name);
  return name;
}
function transferPaths(direction, localPaths = path) {
  return direction === 'upload' ? {source: localPaths, target: path.posix} : {source: path.posix, target: localPaths};
}
module.exports = {absolute, remoteAbsolute, filename, transferPaths};
