'use strict';
const path = require('node:path');
const os = require('node:os');
const WINDOWS_AGENT = '\\\\.\\pipe\\openssh-ssh-agent';

function agentEndpoint(auth, platform = process.platform, home = os.homedir(), env = process.env) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let value;
  switch (auth.agentProvider || 'system') {
    case '1password':
      value = platform === 'win32' ? WINDOWS_AGENT : platform === 'darwin'
        ? paths.join(home, 'Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock')
        : paths.join(home, '.1password/agent.sock');
      break;
    case 'custom': value = auth.agentSocket; break;
    case 'system': value = env.SSH_AUTH_SOCK || (platform === 'win32' ? WINDOWS_AGENT : undefined); break;
    default: throw new Error('Unknown SSH agent provider');
  }
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('No SSH agent endpoint configured. Choose 1Password or provide a custom socket path.');
  if (value.startsWith('~/')) value = paths.join(home, value.slice(2));
  if (platform === 'win32') {
    if (!/^\\\\\.\\pipe\\[^\\/]+$/.test(value)) throw new Error('Windows SSH agents require an absolute named pipe such as \\\\.\\pipe\\openssh-ssh-agent');
  } else if (!paths.isAbsolute(value)) throw new Error('SSH agent socket must be an absolute path');
  return value;
}

function localShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') return {file: env.COMSPEC || 'cmd.exe', args: []};
  return {file: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: platform === 'darwin' ? ['-l'] : []};
}
module.exports = {agentEndpoint, localShell, WINDOWS_AGENT};
