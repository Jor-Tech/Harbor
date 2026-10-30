'use strict';

const { Client, utils } = require('ssh2');
const { selectAgent } = require('./ssh-agent.cjs');
const { authenticationHandler, authenticationFailure } = require('./ssh-auth.cjs');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {forwardConfig, serveSocks, bridge} = require('./forwarding.cjs');

function port(value, fallback, allowZero = false) {
  const result = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(result) || result < (allowZero ? 0 : 1) || result > 65535) {
    throw new Error('Port must be an integer between ' + (allowZero ? '0' : '1') + ' and 65535');
  }
  return result;
}

function textPath(value, local = false) {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) throw new Error('Invalid file path');
  if (local && !path.isAbsolute(value)) throw new Error('Local file path must be absolute');
  return local ? path.normalize(value) : path.posix.normalize(value);
}

function callbackCall(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (error, result) => error ? reject(error) : resolve(result)));
}

class ConnectionManager {
  constructor({ emit = () => {}, verifyHost = async () => false, recordHistory = () => {}, requestAuth = async () => { throw new Error('Interactive authentication is unavailable'); } } = {}) {
    this.emit = emit;
    this.verifyHost = verifyHost;
    this.recordHistory = recordHistory;
    this.requestAuth = requestAuth;
    this.sessions = new Map();
    this.forwards = new Map();
  }

  _status(session, status, error, details = {}) {
    this.emit(session.kind === 'forward' ? 'forward:status' : 'terminal:status', {
      id: session.id, status, ...details, ...(error ? { error: error.message || String(error) } : {}),
    });
  }

  _finish(session, error, reason = 'closed') {
    if (session.closed) return;
    if(error)session.reportAuthFailure?.(error);
    session.closed = true;
    session.authAbort?.abort();
    const rejectPending = session.rejectPending;
    session.rejectPending = null;
    if (rejectPending) rejectPending(error || new Error('Connection was closed'));
    this.sessions.delete(session.id);
    this.forwards.delete(session.id);
    if (session.server) session.server.close();
    for (const socket of session.sockets || []) socket.destroy();
    if (session.pty) session.pty.kill();
    for (const client of session.clients || []) client.destroy();
    if (session.client) session.client.destroy();
    const retryable = !session.shellExited && (reason === 'transport' ||
      ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ENETDOWN','EPIPE','EAI_AGAIN','ENOTFOUND'].includes(error?.code) || error?.level === 'client-timeout');
    this._status(session, error ? 'error' : 'closed', error, {reason:session.shellExited?'exit':reason,retryable});
  }

  async _open(host, credential, kind = 'ssh', route = [], id = randomUUID()) {
    if (!Array.isArray(route) || route.length > 8) throw new Error('A route supports at most eight jump hosts');
    const hops = [...route, {host, credential}];
    for (const hop of hops) {
      const name = hop.host?.hostname || hop.host?.address;
      if (typeof name !== 'string' || !name.trim() || /[\s\0]/.test(name)) throw new Error('Hostname is required');
      port(hop.host.port, 22);
    }
    const session = {
      id, label: host.label || host.name || host.hostname || host.address, kind,
      clients: [], sockets: new Set(), closed: false, host, authAbort: new AbortController(),
    };
    (kind === 'forward' ? this.forwards : this.sessions).set(session.id, session);
    this._status(session, 'connecting');
    try {
      for (const hop of hops) {
        if (session.closed) throw new Error('Connection was closed');
        let sock;
        if (session.client) {
          sock = await this._request(session, done => session.client.forwardOut('127.0.0.1', 0,
            hop.host.hostname || hop.host.address, port(hop.host.port, 22), done));
          this._track(session, sock);
        }
        await this._authenticate(session, hop.host, hop.credential, sock);
      }
      return session;
    } catch (error) { this._finish(session, error); throw error; }
  }

  _track(session, socket) {
    session.sockets.add(socket);
    socket.on('close', () => session.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  }

  _request(session, start) {
    return new Promise((resolve, reject) => {
      if (session.closed) return reject(new Error('Connection was closed'));
      let settled = false;
      const timer = setTimeout(() => done(new Error('SSH request timed out')), 30000);
      const done = (error, value) => {
        if (settled) { value?.destroy?.(); return; }
        settled = true; clearTimeout(timer);
        session.rejectPending = null;
        if (error) reject(error); else resolve(value);
      };
      session.rejectPending = error => done(error);
      try { start(done); } catch (error) { done(error); }
    });
  }

  async _authenticate(session, host, credential, sock) {
    const hostname = host.hostname || host.address, sshPort = port(host.port, 22);
    const auth = credential || {}, username = auth.username || host.username || os.userInfo().username;
    const client = new Client();
    session.client = client; session.clients.push(client);
    try {
      const details={connectionId:session.id,hostname,port:sshPort,username,label:host.label || hostname};
      const ask=async challenge=>{
        if(session.closed)throw new Error('Authentication cancelled');
        const answers=await this.requestAuth({...details,...challenge},{signal:session.authAbort.signal});
        if(session.closed)throw new Error('Authentication cancelled');
        if(!Array.isArray(answers)||answers.length!==challenge.prompts.length||answers.some(a=>typeof a!=='string'||a.length>8192))throw new Error('Invalid authentication response');
        return answers;
      };
      let key=auth.privateKey ?? host.privateKey;
      if(key&&!auth.useAgent){
        let passphrase=auth.passphrase ?? host.passphrase;
        let parsed=utils.parseKey(key,passphrase||undefined);
        for(let attempt=0;parsed instanceof Error && /encrypted|passphrase|decrypt|integrity|bad password/i.test(parsed.message) && attempt<3;attempt++){
          [passphrase]=await ask({kind:'key-passphrase',name:'Unlock SSH key',instructions:attempt||passphrase?'The key could not be unlocked. Enter its passphrase again.':'Enter the passphrase for your SSH private key. It is used only for this connection.',prompts:[{prompt:'Key passphrase',echo:false}]});
          parsed=utils.parseKey(key,passphrase); passphrase=undefined;
        }
        if(parsed instanceof Error)throw new Error('Unable to unlock or parse the SSH private key');
        key=Array.isArray(parsed)?parsed[0]:parsed;
      }else if(auth.useAgent) key=undefined;
      const agent=auth.useAgent?await selectAgent(auth,this.requestAuth,details,session.authAbort.signal):undefined;
      if(session.closed)throw new Error('Authentication cancelled');
      const authState={...details,attemptedMethods:[],acceptedFactors:[],remainingMethods:[],verificationPrompted:false};
      session.reportAuthFailure=error=>{
        const diagnostic=authenticationFailure(error,authState,agent);
        if(!diagnostic)return;
        this.emit('auth:failure',diagnostic);
        error.message='SSH authentication failed. '+diagnostic.explanation;
      };
      let challengeRounds=0;
      client.on('keyboard-interactive',(name,instructions,_language,prompts,finish)=>{
        authState.verificationPrompted=true;
        if(++challengeRounds>10||prompts.length>16){this._finish(session,new Error('Too many authentication challenges'));return;}
        if(!prompts.length){finish([]);return;}
        ask({kind:'keyboard-interactive',name:String(name).slice(0,1024),instructions:String(instructions).slice(0,8192),prompts:prompts.map(p=>({prompt:String(p.prompt).slice(0,2048),echo:p.echo===true}))})
          .then(answers=>{if(!session.closed)finish(answers)},error=>this._finish(session,error));
      });
      await new Promise((resolve, reject) => {
        session.rejectPending = reject;
        let ready = false;
        client.on('error', error => {
          if (!ready) reject(error);
          this._finish(session, error);
        });
        client.on('close', () => {
          if (!ready) reject(new Error('SSH connection closed before it was ready'));
          this._finish(session, undefined, 'transport');
        });
        client.once('ready', () => { ready = true; session.rejectPending = null; session.reportAuthFailure = null; resolve(); });
        client.connect({
          host: hostname, port: sshPort, username, sock,
          password: auth.password ?? host.password,
          agent,
          privateKey: key,
          tryKeyboard: true,
          authHandler: authenticationHandler({username,key,agent,password:auth.password ?? host.password,ask,fail:error=>this._finish(session,error),isClosed:()=>session.closed,state:authState}),
          readyTimeout: 180000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key, answer) => {
            let algorithm = 'unknown';
            try {
              const parsed = utils.parseKey(key);
              if (!(parsed instanceof Error)) algorithm = parsed.type;
            } catch { /* An unrecognized key still requires explicit verification. */ }
            const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
            Promise.resolve().then(() => this.verifyHost({ hostname, port: sshPort, fingerprint, algorithm }))
              .then(accepted => answer(accepted === true && !session.closed), () => answer(false));
          },
        });
      });
      if (session.closed) throw new Error('Connection was closed');
      return session;
    } catch (error) {
      this._finish(session, error);
      throw error;
    }
  }

  async connect(host, credential, route = [], id) {
    const session = await this._open(host, credential, 'ssh', route, id);
    try {
      session.stream = await this._request(session, done => session.client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, done));
      if (session.closed) { session.stream.close(); throw new Error('Connection was closed'); }
      session.stream.setEncoding('utf8');
      session.stream.on('data', data => { if (!session.closed) this.emit('terminal:data', { id: session.id, data }); });
      session.stream.stderr.setEncoding('utf8');
      session.stream.stderr.on('data', data => { if (!session.closed) this.emit('terminal:data', { id: session.id, data }); });
      session.stream.on('error', error => this._finish(session, error));
      session.stream.on('exit', () => { session.shellExited = true; });
      // A transport loss also closes its channels. Let the client close event
      // identify that case before treating a channel-only close as shell exit.
      session.stream.on('close', () => setImmediate(() => this._finish(session, undefined, 'exit')));
      this._status(session, 'connected');
      await Promise.resolve().then(() => this.recordHistory({ hostId: host.id, label: session.label, hostname: host.hostname || host.address, connectedAt: new Date().toISOString() })).catch(() => {});
      if (session.closed) throw new Error('Connection was closed');
      return { id: session.id, label: session.label };
    } catch (error) { this._finish(session, error); throw error; }
  }

  async local(id = randomUUID()) {
    const pty = require('node-pty');
    const shell = require('./platform.cjs').localShell();
    const session = { id, label: 'Local terminal', kind: 'local', closed: false };
    session.pty = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    this.sessions.set(session.id, session);
    session.pty.onData(data => { if (!session.closed) this.emit('terminal:data', { id: session.id, data }); });
    session.pty.onExit(() => this._finish(session, undefined, 'exit'));
    this._status(session, 'connected');
    return { id: session.id, label: session.label };
  }

  _session(id) {
    const session = this.sessions.get(id);
    if (!session || session.closed) throw new Error('Unknown or closed terminal session');
    return session;
  }

  write(id, data) {
    const session = this._session(id);
    if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) throw new Error('Invalid terminal input');
    if (session.pty) session.pty.write(data);
    else if (session.stream) session.stream.write(data);
    else throw new Error('Terminal is not ready');
  }

  resize(id, cols, rows) {
    const session = this._session(id);
    if (![cols, rows].every(value => Number.isInteger(value) && value > 0 && value <= 1000)) throw new Error('Invalid terminal dimensions');
    if (session.pty) session.pty.resize(cols, rows);
    else if (session.stream) session.stream.setWindow(rows, cols, 0, 0);
  }

  close(id) {
    const session = this.sessions.get(id);
    if (session) this._finish(session);
  }

  closeAll() {
    for (const session of [...this.sessions.values(), ...this.forwards.values()]) this._finish(session);
  }

  async _sftp(id) {
    const session = this._session(id);
    if (!session.client) throw new Error('SFTP requires an SSH connection');
    if (!session.sftpPromise) {
      session.sftpPromise = callbackCall(session.client, 'sftp').then(sftp => {
        sftp.on('error', () => { session.sftpPromise = null; });
        sftp.on('close', () => { session.sftpPromise = null; });
        return sftp;
      }).catch(error => { session.sftpPromise = null; throw error; });
    }
    return session.sftpPromise;
  }

  async listFiles(id, directory = '.') {
    const remotePath = textPath(directory);
    const sftp = await this._sftp(id);
    const actualPath = await callbackCall(sftp, 'realpath', remotePath);
    const files = await callbackCall(sftp, 'readdir', actualPath);
    return {
      path: actualPath,
      entries: files.filter(entry => entry.filename !== '.' && entry.filename !== '..').map(entry => ({
        name: entry.filename, isDirectory: entry.attrs.isDirectory(), isSymlink:entry.attrs.isSymbolicLink(), mode:entry.attrs.mode&0o777, size: entry.attrs.size,
        modified: entry.attrs.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : null,
      })).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)),
    };
  }

  async upload(id, localPath, remotePath) {
    localPath = textPath(localPath, true);
    remotePath = textPath(remotePath);
    if (!(await fs.stat(localPath)).isFile()) throw new Error('Upload source must be a regular file');
    const sftp = await this._sftp(id);
    await callbackCall(sftp, 'fastPut', localPath, remotePath, { mode: 0o600 });
  }

  async download(id, remotePath, localPath) {
    remotePath = textPath(remotePath);
    localPath = textPath(localPath, true);
    const sftp = await this._sftp(id);
    const attrs = await callbackCall(sftp, 'stat', remotePath);
    if (!attrs.isFile()) throw new Error('Download source must be a regular file');
    const temporary = path.join(path.dirname(localPath), '.' + path.basename(localPath) + '.' + randomUUID() + '.part');
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      await handle.close();
      await callbackCall(sftp, 'fastGet', remotePath, temporary);
      await fs.rename(temporary, localPath);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async mkdir(id, remotePath) {
    remotePath = textPath(remotePath);
    await callbackCall(await this._sftp(id), 'mkdir', remotePath, { mode: 0o700 });
  }

  async removeFile(id, remotePath) {
    remotePath = textPath(remotePath);
    if (['/', '.', '..'].includes(remotePath)) throw new Error('Refusing to remove root or current directory');
    const sftp = await this._sftp(id);
    const attrs = await callbackCall(sftp, 'lstat', remotePath);
    await callbackCall(sftp, attrs.isDirectory() ? 'rmdir' : 'unlink', remotePath);
  }

  async startForward(host, credential, config = {}, route = []) {
    const rule = forwardConfig(config);
    const session = await this._open(host, credential, 'forward', route);
    const outgoing = (socket, hostname, targetPort, done) => {
      const timer = setTimeout(() => socket.destroy(), 30000);
      socket.once('close', () => clearTimeout(timer));
      session.client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0,
        hostname, targetPort, (error, stream) => {
          clearTimeout(timer);
          if (error) { if (done) done(error); else socket.destroy(); return; }
          if (session.closed || socket.destroyed) { stream.destroy(); return; }
          this._track(session, stream);
          if (done) done(null, stream); else bridge(socket, stream);
        });
    };
    try {
      let boundPort;
      if (rule.type === 'remote') {
        session.client.on('tcp connection', (info, accept, reject) => {
          if (session.closed || info.destIP !== '127.0.0.1' || info.destPort !== boundPort) { reject(); return; }
          const stream = this._track(session, accept());
          const socket = this._track(session, net.connect({host:rule.destinationHost, port:rule.destinationPort, allowHalfOpen:true}));
          const timer = setTimeout(() => { socket.destroy(); stream.destroy(); }, 30000);
          socket.once('close', () => clearTimeout(timer));
          socket.once('connect', () => clearTimeout(timer));
          bridge(socket, stream);
        });
        await this._request(session, done => session.client.forwardIn('127.0.0.1', rule.listenPort, (error, assigned) => {
          if (error) { done(error); return; }
          try { boundPort = port(assigned || rule.listenPort); done(); } catch (error) { done(error); }
        }));
      } else {
        session.server = net.createServer({allowHalfOpen:true}, socket => {
          this._track(session, socket);
          if (session.closed) { socket.destroy(); return; }
          if (rule.type === 'dynamic') serveSocks(socket, (name, targetPort, done) => outgoing(socket, name, targetPort, done));
          else outgoing(socket, rule.destinationHost, rule.destinationPort);
        });
        session.server.maxConnections = 128;
        await this._request(session, done => {
          session.server.once('error', done);
          session.server.listen(rule.listenPort, '127.0.0.1', () => {
            if (session.closed) { session.server.close(); return; }
            session.server.removeListener('error', done);
            session.server.on('error', error => this._finish(session, error));
            done();
          });
        });
        boundPort = session.server.address().port;
      }
      if (session.closed) throw new Error('Connection was closed');
      this._status(session, 'connected');
      return {id:session.id, port:boundPort, type:rule.type};
    } catch (error) { this._finish(session, error); throw error; }
  }

  stopForward(id) {
    const session = this.forwards.get(id);
    if (session) this._finish(session);
  }
}

module.exports = { ConnectionManager };
