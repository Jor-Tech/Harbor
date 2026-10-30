'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, createHash } = require('node:crypto');
const { Server, utils } = require('ssh2');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { ConnectionManager } = require('../electron/connections.cjs');

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const publicKey = utils.parseKey(privateKey).getPublicSSH();
const fingerprint = 'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');

async function fixture(t, verifyHost = async () => true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-ssh-test-'));
  const clients = new Set();
  const events = [];
  const history = [];
  const verification = [];
  const manager = new ConnectionManager({
    emit: (event, payload) => events.push({ event, ...payload }),
    verifyHost: details => { verification.push(details); return verifyHost(details); },
    recordHistory: entry => history.push(entry),
  });
  const server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'test' && context.password === 'correct') context.accept();
      else context.reject();
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', acceptPty => acceptPty());
        session.on('window-change', acceptWindow => acceptWindow && acceptWindow());
        session.on('shell', acceptShell => {
          const stream = acceptShell();
          stream.on('error', () => {});
          stream.write('welcome\r\n');
          stream.on('data', data => stream.write(data));
        });
        session.on('sftp', acceptSftp => serveSftp(acceptSftp(), root));
      });
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || info.destPort !== 9000) { reject(); return; }
        const stream = accept();
        stream.on('error', () => {});
        stream.on('data', data => stream.write(data));
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    manager.closeAll();
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, manager, events, history, verification,
    host: { id: 'test-host', hostname: '127.0.0.1', port: server.address().port, username: 'test', label: 'Test server' },
    credential: { password: 'correct' } };
}

function serveSftp(sftp, root) {
  const status = utils.sftp.STATUS_CODE;
  const handles = new Map();
  let nextHandle = 0;
  const local = remote => path.join(root, path.posix.normalize('/' + remote));
  const fail = (id, error) => sftp.status(id, error.code === 'ENOENT' ? status.NO_SUCH_FILE : status.FAILURE);
  const handle = item => {
    const key = String(++nextHandle);
    handles.set(key, item);
    return Buffer.from(key);
  };
  const attributes = stat => ({ mode: stat.mode, size: stat.size, uid: stat.uid, gid: stat.gid,
    atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
  sftp.on('error', () => {});
  sftp.on('REALPATH', (id, remote) => sftp.name(id, [{ filename: path.posix.resolve('/', remote), longname: '', attrs: {} }]));
  for (const operation of ['STAT', 'LSTAT']) {
    sftp.on(operation, (id, remote) => fs[operation === 'STAT' ? 'stat' : 'lstat'](local(remote))
      .then(stat => sftp.attrs(id, attributes(stat)), error => fail(id, error)));
  }
  sftp.on('OPENDIR', (id, remote) => fs.readdir(local(remote), { withFileTypes: true }).then(async entries => {
    const names = await Promise.all(entries.map(async entry => ({ filename: entry.name, longname: entry.name, attrs: attributes(await fs.stat(path.join(local(remote), entry.name))) })));
    sftp.handle(id, handle({ names }));
  }).catch(error => fail(id, error)));
  sftp.on('READDIR', (id, value) => {
    const entry = handles.get(value.toString());
    if (entry.names.length) { sftp.name(id, entry.names); entry.names = []; }
    else sftp.status(id, status.EOF);
  });
  sftp.on('OPEN', (id, remote, flags, attrs) => fs.open(local(remote), flags & 2 ? 'w' : 'r', attrs.mode || 0o600)
    .then(file => sftp.handle(id, handle({ file })), error => fail(id, error)));
  sftp.on('FSTAT', (id, value) => handles.get(value.toString()).file.stat()
    .then(stat => sftp.attrs(id, attributes(stat)), error => fail(id, error)));
  sftp.on('READ', (id, value, offset, length) => {
    const buffer = Buffer.alloc(length);
    handles.get(value.toString()).file.read(buffer, 0, length, offset).then(({ bytesRead }) => {
      if (bytesRead) sftp.data(id, buffer.subarray(0, bytesRead));
      else sftp.status(id, status.EOF);
    }, error => fail(id, error));
  });
  sftp.on('WRITE', (id, value, offset, data) => handles.get(value.toString()).file.write(data, 0, data.length, offset)
    .then(() => sftp.status(id, status.OK), error => fail(id, error)));
  sftp.on('CLOSE', async (id, value) => {
    const entry = handles.get(value.toString());
    handles.delete(value.toString());
    if (entry?.file) await entry.file.close();
    sftp.status(id, status.OK);
  });
  for (const [operation, method] of [['REMOVE', 'unlink'], ['RMDIR', 'rmdir'], ['MKDIR', 'mkdir']]) {
    sftp.on(operation, (id, remote) => fs[method](local(remote)).then(() => sftp.status(id, status.OK), error => fail(id, error)));
  }
  sftp.on('close', () => { for (const entry of handles.values()) if (entry.file) entry.file.close().catch(() => {}); });
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Expected event did not arrive');
}

test('SSH verifies real host key asynchronously, echoes terminal input, and closes cleanly', async t => {
  const f = await fixture(t, async details => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return details.fingerprint === fingerprint;
  });
  const terminal = await f.manager.connect(f.host, f.credential);
  assert.equal(terminal.label, 'Test server');
  assert.equal(f.verification[0].algorithm, 'ssh-rsa');
  assert.equal(f.verification[0].port, f.host.port);
  f.manager.resize(terminal.id, 120, 40);
  f.manager.write(terminal.id, 'hello terminal\n');
  await eventually(() => f.events.some(event => event.event === 'terminal:data' && event.data.includes('hello terminal')));
  assert.equal(f.history.length, 1);
  assert.equal(f.history[0].hostId, 'test-host');
  f.manager.close(terminal.id);
  assert.throws(() => f.manager.write(terminal.id, 'x'), /Unknown or closed/);
  assert.equal(f.manager.sessions.size, 0);
});

test('rejected or failed host verification prevents SSH access', async t => {
  for (const verify of [async () => false, async () => { throw new Error('untrusted'); }]) {
    const f = await fixture(t, verify);
    await assert.rejects(f.manager.connect(f.host, f.credential), /verification failed/);
    assert.equal(f.manager.sessions.size, 0);
    assert.equal(f.history.length, 0);
  }
});

test('closing all sessions cancels a connection waiting for host verification', { timeout: 5000 }, async t => {
  let answer;
  const f = await fixture(t, () => new Promise(resolve => { answer = resolve; }));
  const connecting = f.manager.connect(f.host, f.credential);
  const rejection = assert.rejects(connecting, /closed/);
  await eventually(() => answer);
  f.manager.closeAll();
  await rejection;
  answer(true);
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.history.length, 0);
  assert.equal(f.events.filter(event => event.status === 'closed').length, 1);
});

test('connect waits for history persistence and rejects if closed during persistence', async t => {
  const f = await fixture(t);
  let persisted;
  f.manager.recordHistory = () => new Promise(resolve => { persisted = resolve; });
  const connecting = f.manager.connect(f.host, f.credential);
  const rejection = assert.rejects(connecting, /closed/);
  await eventually(() => persisted);
  f.manager.closeAll();
  persisted();
  await rejection;
  assert.equal(f.manager.sessions.size, 0);
});

test('SFTP lists and transfers files, creates folders, and removes entries', async t => {
  const f = await fixture(t);
  const terminal = await f.manager.connect(f.host, f.credential);
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-transfer-'));
  t.after(() => fs.rm(localRoot, { recursive: true, force: true }));
  const original = path.join(localRoot, 'source.txt');
  const downloaded = path.join(localRoot, 'downloaded.txt');
  await fs.writeFile(original, 'private transfer content\n');
  await f.manager.mkdir(terminal.id, '/files');
  await f.manager.upload(terminal.id, original, '/files/upload.txt');
  const listing = await f.manager.listFiles(terminal.id, '/files');
  assert.equal(listing.path, '/files');
  assert.equal(listing.entries[0].name, 'upload.txt');
  assert.equal(listing.entries[0].isDirectory, false);
  await f.manager.download(terminal.id, '/files/upload.txt', downloaded);
  assert.equal(await fs.readFile(downloaded, 'utf8'), 'private transfer content\n');
  if(process.platform!=='win32')assert.equal((await fs.stat(downloaded)).mode & 0o777, 0o600);
  await assert.rejects(f.manager.download(terminal.id, '/files', downloaded), /regular file/);
  await assert.rejects(f.manager.upload(terminal.id, 'relative.txt', '/x'), /absolute/);
  await assert.rejects(f.manager.removeFile(terminal.id, '/'), /Refusing/);
  await f.manager.removeFile(terminal.id, '/files/upload.txt');
  await f.manager.removeFile(terminal.id, '/files');
  assert.deepEqual((await f.manager.listFiles(terminal.id, '/')).entries, []);
});

test('local forwarding binds loopback and carries bytes through SSH', async t => {
  const f = await fixture(t);
  const forward = await f.manager.startForward(f.host, f.credential, { localPort: 0, remoteHost: '127.0.0.1', remotePort: 9000 });
  assert.equal(f.manager.forwards.get(forward.id).server.address().address, '127.0.0.1');
  const socket = net.connect(forward.port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('forwarded bytes');
  const [response] = await once(socket, 'data');
  assert.equal(response.toString(), 'forwarded bytes');
  f.manager.stopForward(forward.id);
  assert.equal(f.manager.forwards.size, 0);
});

test('invalid inputs and unknown sessions fail clearly', async () => {
  const manager = new ConnectionManager();
  await assert.rejects(manager.connect({ hostname: 'localhost', port: -1 }), /Port/);
  await assert.rejects(manager.connect({}), /Hostname/);
  await assert.rejects(manager.startForward({ hostname: 'localhost' }, {}, { remotePort: 0 }), /Port/);
  await assert.rejects(manager.listFiles('unknown', '/'), /Unknown or closed/);
  manager.close('unknown');
  manager.stopForward('unknown');
  manager.closeAll();
});
