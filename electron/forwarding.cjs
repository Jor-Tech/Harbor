'use strict';

function forwardConfig(config = {}) {
  const type = config.type ?? 'local';
  if (!['local', 'remote', 'dynamic'].includes(type)) throw new Error('Unknown forwarding type');
  const number = (value, zero) => {
    const n = Number(value);
    if (!['number','string'].includes(typeof value) || value === '' || !Number.isInteger(n) || n < (zero ? 0 : 1) || n > 65535) throw new Error('Port must be an integer between ' + (zero ? 0 : 1) + ' and 65535');
    return n;
  };
  const listenPort = number(config.listenPort ?? config.localPort ?? 0, true);
  if (type === 'dynamic') return {type, listenPort};
  const destinationHost = config.destinationHost ?? config.remoteHost ?? '127.0.0.1';
  if (typeof destinationHost !== 'string' || !destinationHost || destinationHost.length > 253 || /[\s\0]/.test(destinationHost)) throw new Error('Invalid forwarding destination');
  return {type, listenPort, destinationHost, destinationPort:number(config.destinationPort ?? config.remotePort, false)};
}

function bridge(socket, stream) {
  socket.on('error', () => stream.destroy());
  stream.on('error', () => socket.destroy());
  socket.on('close', () => stream.destroy());
  stream.on('close', () => socket.end(() => socket.destroy()));
  socket.pipe(stream).pipe(socket);
}

// Loopback-only SOCKS5 CONNECT. DNS names are passed to SSH, never resolved locally.
function serveSocks(socket, connect) {
  let buffer = Buffer.alloc(0), phase = 'greeting';
  const timer = setTimeout(() => socket.destroy(), 30000);
  socket.once('close', () => clearTimeout(timer));
  const reply = code => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
  const end = data => { phase = 'done'; socket.removeListener('data', receive); socket.end(data, () => socket.destroy()); };
  const fail = code => end(reply(code));
  function receive(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 65536) { socket.destroy(); return; }
    if (phase === 'greeting') {
      if (buffer.length < 2) return;
      if (buffer[0] !== 5 || !buffer[1]) { end(Buffer.from([5,255])); return; }
      if (buffer.length < 2 + buffer[1]) return;
      if (!buffer.subarray(2, 2 + buffer[1]).includes(0)) { end(Buffer.from([5,255])); return; }
      buffer = buffer.subarray(2 + buffer[1]); phase = 'request'; socket.write(Buffer.from([5,0]));
    }
    if (phase !== 'request' || buffer.length < 4) return;
    if (buffer[0] !== 5 || buffer[2] !== 0) { fail(1); return; }
    if (buffer[1] !== 1) { fail(7); return; } // No BIND or UDP ASSOCIATE.
    const type = buffer[3];
    if (![1,3,4].includes(type)) { fail(8); return; }
    if (type === 3 && buffer.length < 5) return;
    const size = type === 1 ? 4 : type === 4 ? 16 : buffer[4], start = type === 3 ? 5 : 4;
    if (!size) { fail(8); return; }
    if (buffer.length < start + size + 2) return;
    const address = buffer.subarray(start, start + size);
    let host;
    if (type === 1) host = [...address].join('.');
    else if (type === 4) host = Array.from({length:8}, (_, i) => address.readUInt16BE(i*2).toString(16)).join(':');
    else {
      if ([...address].some(b => b < 33 || b > 126)) { fail(8); return; }
      host = address.toString('ascii');
    }
    const port = buffer.readUInt16BE(start + size);
    if (!port) { fail(1); return; }
    const extra = buffer.subarray(start + size + 2);
    phase = 'connecting'; socket.pause(); socket.removeListener('data', receive);
    if (extra.length) socket.unshift(extra);
    try {
      connect(host, port, (error, stream) => {
        if (socket.destroyed) { stream?.destroy(); return; }
        if (error) { fail(5); return; }
        clearTimeout(timer); socket.write(reply(0)); bridge(socket, stream);
      });
    } catch { fail(1); }
  }
  socket.on('data', receive);
}

module.exports = {forwardConfig, serveSocks, bridge};
