'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Vault } = require('../electron/vault.cjs');
const password = 'a private test passphrase';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-vault-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, vault: new Vault(path.join(dir, 'vault.json')) };
}

test('encrypts at rest, snapshots reads, persists and locks', async t => {
  const { dir, vault } = await setup(t);
  assert.deepEqual(await vault.status(), { exists: false, locked: true, path: path.join(dir, 'vault.json') });
  const data = await vault.create(password);
  data.hosts.push({ id: 'host-1', name: 'Secret server', password: 'top-secret-credential' });
  await vault.save(data);
  const bytes = await fs.readFile(vault.path, 'utf8');
  assert.equal(bytes.includes('top-secret-credential'), false);
  assert.equal(bytes.includes('Secret server'), false);
  if(process.platform!=='win32')assert.equal((await fs.stat(vault.path)).mode & 0o777, 0o600);
  data.hosts[0].name = 'Caller changed';
  assert.equal((await vault.read()).hosts[0].name, 'Secret server');
  const previousKey = vault._key;
  vault.lock();
  assert.ok(previousKey.every(x => x === 0));
  await assert.rejects(vault.read(), /locked/);
  await assert.rejects(vault.unlock('wrong password'), /Incorrect password/);
  assert.equal((await vault.status()).locked, true);
  assert.equal((await vault.unlock(password)).hosts[0].name, 'Secret server');
  await assert.rejects(vault.create(password), /already exists/);
});

test('rejects ciphertext and authenticated metadata tampering', async t => {
  const { vault } = await setup(t);
  await vault.create(password); vault.lock();
  const original = await fs.readFile(vault.path, 'utf8');
  for (const mutate of [e => { e.revision++; }, e => { e.ancestors = ['a'.repeat(64)]; }, e => { e.data = Buffer.from('garbage').toString('base64'); }]) {
    const envelope = JSON.parse(original); mutate(envelope);
    await fs.writeFile(vault.path, JSON.stringify(envelope));
    await assert.rejects(vault.unlock(password), /Incorrect password/);
  }
  const envelope = JSON.parse(original); envelope.kdf.N = 1;
  await fs.writeFile(vault.path, JSON.stringify(envelope));
  await assert.rejects(vault.unlock(password), /Unsupported vault encryption/);
});

test('serializes writes and rejects stale writers without data loss', async t => {
  const { vault } = await setup(t);
  const base = await vault.create(password);
  const other = new Vault(vault.path); await other.unlock(password);
  const first = structuredClone(base), second = structuredClone(base);
  first.hosts.push({ id: 'first' }); second.hosts.push({ id: 'second' });
  await Promise.all([vault.save(first), vault.save(second)]);
  assert.equal((await vault.read()).hosts[0].id, 'second');
  assert.equal(JSON.parse(await fs.readFile(vault.path, 'utf8')).revision, 3);
  await assert.rejects(other.save(base), /changed on disk/);
  assert.equal((await vault.read()).hosts[0].id, 'second');
});

test('password rotation authenticates old password and revokes it', async t => {
  const { vault } = await setup(t);
  assert.throws(() => vault.create('short-pass'), /between 12 and 1024/);
  await vault.create(password);
  assert.throws(() => vault.changePassword(password, 'short-pass'), /between 12 and 1024/);
  await assert.rejects(vault.changePassword('wrong password', 'replacement password'), /Incorrect password/);
  await vault.changePassword(password, 'replacement password'); vault.lock();
  await assert.rejects(vault.unlock(password), /Incorrect password/);
  await vault.unlock('replacement password');
});

test('encrypted export and import require explicit replacement and preserve backup', async t => {
  const { dir, vault } = await setup(t);
  const data = await vault.create(password); data.keys.push({ id: 'ssh-key', privateKey: 'secret-key' }); await vault.save(data);
  vault.lock();
  const exported = path.join(dir, 'portable.harbor-vault'); await vault.exportTo(exported);
  await assert.rejects(vault.exportTo(exported), /EEXIST/);
  const other = new Vault(path.join(dir, 'other.json'));
  await assert.rejects(other.importFrom(exported, 'wrong password'), /Incorrect password/);
  assert.equal((await other.status()).exists, false);
  assert.equal((await other.importFrom(exported, password)).keys[0].id, 'ssh-key');
  await assert.rejects(other.importFrom(exported, password), /Explicit replacement/);
  await other.importFrom(exported, password, true);
  assert.equal((await other.listBackups()).backups.filter(x => x.reason === 'import').length, 1);
});

test('folder sync pushes, pulls, and preserves diverging histories', async t => {
  const { dir, vault: a } = await setup(t);
  await a.create(password);
  const folder = path.join(dir, 'sync'); await fs.mkdir(folder);
  const first = await a.sync(folder); assert.equal(first.status, 'pushed');
  assert.equal((await a.sync(folder)).status, 'unchanged');
  const b = new Vault(path.join(dir, 'device-b.json')); await b.importFrom(first.path, password);
  let data = await a.read(); data.hosts.push({ id: 'shared-host' }); await a.save(data);
  assert.equal((await a.sync(folder)).status, 'pushed');
  const pull = await b.sync(folder); assert.equal(pull.status, 'pulled'); assert.equal(pull.data.hosts[0].id, 'shared-host');
  data = await a.read(); data.hosts.push({ id: 'device-a' }); await a.save(data);
  data = await b.read(); data.hosts.push({ id: 'device-b' }); await b.save(data);
  await a.sync(folder);
  const sharedBefore = await fs.readFile(first.path, 'utf8');
  const conflict = await b.sync(folder); assert.equal(conflict.status, 'conflict');
  assert.equal(await fs.readFile(first.path, 'utf8'), sharedBefore);
  assert.equal(await fs.readFile(conflict.conflictPath, 'utf8'), await fs.readFile(b.path, 'utf8'));
  assert.equal((await b.read()).hosts[1].id, 'device-b');
  const historyDir = (await fs.readdir(folder)).find(x => x.endsWith('.history'));
  assert.ok((await fs.readdir(path.join(folder, historyDir))).length >= 4);
});

test('rotation can sync but other devices must authenticate new password', async t => {
  const { dir, vault: a } = await setup(t);
  await a.create(password); const folder = path.join(dir, 'sync'); await fs.mkdir(folder); const first = await a.sync(folder);
  const b = new Vault(path.join(dir, 'device-b.json')); await b.importFrom(first.path, password);
  await a.changePassword(password, 'a different password'); assert.equal((await a.sync(folder)).status, 'pushed');
  await assert.rejects(b.sync(folder), /password may have changed/);
  await b.importFrom(first.path, 'a different password', true);
  assert.equal((await b.sync(folder)).status, 'unchanged');
});

test('tampered remote ancestry cannot authorize replacing a local vault', async t => {
  const { dir, vault } = await setup(t); await vault.create(password);
  await fs.mkdir(path.join(dir, 'sync'));
  const shared = await vault.sync(path.join(dir, 'sync'));
  const localBefore = await fs.readFile(vault.path, 'utf8');
  const envelope = JSON.parse(localBefore); envelope.revision++; envelope.ancestors.push(vault._hash);
  await fs.writeFile(shared.path, JSON.stringify(envelope));
  await assert.rejects(vault.sync(path.join(dir, 'sync')), /cannot be authenticated/);
  assert.equal(await fs.readFile(vault.path, 'utf8'), localBefore);
});

test('lock cancels in-flight unlocking and data validation rejects unsafe values', async t => {
  const { vault } = await setup(t); const data = await vault.create(password); vault.lock();
  const queuedUnlock = vault.unlock(password); vault.lock();
  await assert.rejects(queuedUnlock, /locked during/);
  const unlocking = vault.unlock(password);
  await new Promise(resolve => setTimeout(resolve, 10)); vault.lock();
  await assert.rejects(unlocking, /locked during/);
  assert.equal((await vault.status()).locked, true);
  await vault.unlock(password);
  data.hosts = [{ id: 'same' }, { id: 'same' }]; assert.throws(() => vault.save(data), /duplicate/);
  data.hosts = []; data.settings = JSON.parse('{"__proto__":{"bad":true}}'); assert.throws(() => vault.save(data), /Invalid vault property/);
});

for (const choice of ['local', 'remote']) {
  test(`conflict resolution keeps ${choice} contents and fast-forwards both branches`, async t => {
    const { dir, vault: a } = await setup(t);
    await a.create(password);
    const folder = path.join(dir, 'sync'); await fs.mkdir(folder); const first = await a.sync(folder);
    const b = new Vault(path.join(dir, 'device-b.json')); await b.importFrom(first.path, password);
    let data = await a.read(); data.hosts.push({ id: 'device-a' }); await a.save(data);
    data = await b.read(); data.hosts.push({ id: 'device-b' }); await b.save(data);
    await a.sync(folder);
    const aHash = a._hash, bHash = b._hash;
    const aBytes = await fs.readFile(a.path), bBytes = await fs.readFile(b.path);
    assert.equal((await b.sync(folder)).status, 'conflict');
    const result = await b.resolveSync(folder, choice);
    assert.equal(result.status, `resolved-${choice}`);
    assert.equal(result.data.hosts[0].id, choice === 'local' ? 'device-b' : 'device-a');
    const merged = JSON.parse(await fs.readFile(b.path, 'utf8'));
    assert.ok(merged.ancestors.includes(aHash)); assert.ok(merged.ancestors.includes(bHash));
    assert.equal((await a.sync(folder)).status, 'pulled');
    assert.deepEqual(await a.read(), await b.read());
    assert.equal((await b.sync(folder)).status, 'unchanged');
    assert.ok((await fs.readFile(path.join(folder, `${merged.id}.history`, `${aHash}.harbor-vault`))).equals(aBytes));
    assert.ok((await fs.readFile(path.join(folder, `${merged.id}.history`, `${bHash}.harbor-vault`))).equals(bBytes));
  });
}

test('conflict resolution rejects a tampered shared vault without changing local data', async t => {
  const { dir, vault } = await setup(t); await vault.create(password);
  const folder = path.join(dir, 'sync'); await fs.mkdir(folder); const shared = await vault.sync(folder);
  const localBefore = await fs.readFile(vault.path, 'utf8');
  const envelope = JSON.parse(localBefore); envelope.revision++;
  await fs.writeFile(shared.path, JSON.stringify(envelope));
  for (const choice of ['local', 'remote']) {
    await assert.rejects(vault.resolveSync(folder, choice), /cannot be authenticated/);
    assert.equal(await fs.readFile(vault.path, 'utf8'), localBefore);
  }
  assert.throws(() => vault.resolveSync(folder, 'anything'), /Choose versions from the conflict comparison/);
});
