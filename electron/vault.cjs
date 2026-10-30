'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const {compareData,mergeChoices}=require('./vault-conflicts.cjs');
const MAX_BYTES = 8 * 1024 * 1024;
const BACKUP_NAME = /^(\d{13})-[0-9a-f-]{36}-(save|password|upgrade|import|sync|resolve|manual|recovery)\.hbr$/;
const LEGACY_BACKUP = /^(\d{13})-[0-9a-f-]{36}$/;
// Versioned, bounded profiles: never pass file-controlled work factors to scrypt.
const LEGACY = Object.freeze({version:1, kdf:Object.freeze({name:'scrypt', N:32768, r:8, p:1})});
const CURRENT = Object.freeze({version:2, kdf:Object.freeze({name:'scrypt', N:131072, r:8, p:1})});
function encryptionProfile(e) {
  const profile = e.version === 1 ? LEGACY : e.version === 2 ? CURRENT : null;
  if (!profile || JSON.stringify(e.kdf) !== JSON.stringify(profile.kdf) || e.cipher !== 'aes-256-gcm') throw new Error('Unsupported vault encryption. Update Harbor if this vault was upgraded on another device.');
  return profile;
}
const COLLECTIONS = ['hosts', 'groups', 'keys', 'snippets', 'forwardings', 'history', 'workspaces'];
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const initialData = () => ({ version: 1, workspaces: [], hosts: [], groups: [], keys: [], snippets: [], forwardings: [], knownHosts: {}, settings: { theme: 'dark', fontSize: 14, autoLockMinutes: 15 }, history: [] });

function passwordCheck(password, creating = false) {
  if (typeof password !== 'string' || password.length > 1024 || password.length < (creating ? 12 : 1)) {
    throw new Error(creating ? 'Use a password between 12 and 1024 characters.' : 'Invalid vault password.');
  }
}

function validateData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || ![Object.prototype,null].includes(Object.getPrototypeOf(data)) || data.version !== 1) throw new Error('Unsupported vault data.');
  data = { ...data, workspaces: data.workspaces ?? [] };
  let nodes = 0;
  function inspect(value, depth) {
    if (++nodes > 150000 || depth > 20) throw new Error('Vault data is too complex.');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && value.length <= 1024 * 1024) return;
    if (typeof value !== 'object' || !value) throw new Error('Invalid vault value.');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Vault values must be plain objects.');
    if (Array.isArray(value) && value.length > 10000) throw new Error('Too many vault entries.');
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 1024 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid vault property.');
      inspect(item, depth + 1);
    }
  }
  inspect(data, 0);
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(data[collection])) throw new Error(`Invalid ${collection} collection.`);
    const ids = new Set();
    for (const item of data[collection]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid ${collection} entry.`);
      // History entries may be event records without a persistent identity.
      if (collection !== 'history' || item.id !== undefined) {
        if (typeof item.id !== 'string' || !item.id || item.id.length > 200 || ids.has(item.id)) throw new Error(`Invalid or duplicate ${collection} id.`);
        ids.add(item.id);
      }
    }
  }
  for (const field of ['knownHosts', 'settings']) {
    if (!data[field] || typeof data[field] !== 'object' || Array.isArray(data[field])) throw new Error(`Invalid ${field}.`);
  }
  const {validateGroups,validateWorkspace,resolveRoute}=require('./host-model.cjs');
  validateGroups(data);
  for(const host of data.hosts)resolveRoute(data,host);
  for(const workspace of data.workspaces)validateWorkspace(workspace);
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('Vault exceeds the 8 MiB limit.');
  return JSON.parse(json);
}

function decode(value, length, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`Invalid vault ${name}.`);
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || (length !== null && result.length !== length)) throw new Error(`Invalid vault ${name}.`);
  return result;
}

function parseEnvelope(bytes) {
  if (bytes.length > MAX_BYTES * 1.5) throw new Error('Vault file is too large.');
  let e;
  try { e = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid vault file.'); }
  if (!e || e.format !== 'harbor-vault' || ![1,2].includes(e.version) || typeof e.id !== 'string' || !/^[0-9a-f-]{36}$/.test(e.id) || !Number.isSafeInteger(e.revision) || e.revision < 1) throw new Error('Unsupported vault file.');
  encryptionProfile(e);
  if (!Array.isArray(e.ancestors) || e.ancestors.length > 128 || e.ancestors.some(x => typeof x !== 'string' || !/^[0-9a-f]{64}$/.test(x))) throw new Error('Invalid vault ancestry.');
  decode(e.salt, 32, 'salt'); decode(e.iv, 12, 'nonce'); decode(e.tag, 16, 'tag');
  if (decode(e.data, null, 'ciphertext').length > MAX_BYTES) throw new Error('Vault file is too large.');
  return e;
}

function aad(e) {
  return Buffer.from(JSON.stringify({ format: e.format, version: e.version, id: e.id, revision: e.revision, ancestors: e.ancestors, kdf: e.kdf, cipher: e.cipher, salt: e.salt }));
}

async function derive(password, salt, profile = CURRENT) {
  passwordCheck(password);
  return scrypt(password, decode(salt, 32, 'salt'), 32, { ...profile.kdf, maxmem: 256 * 1024 * 1024 });
}

function decrypt(e, key) {
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, decode(e.iv, 12, 'nonce'));
    decipher.setAAD(aad(e)); decipher.setAuthTag(decode(e.tag, 16, 'tag'));
    plaintext = Buffer.concat([decipher.update(decode(e.data, null, 'ciphertext')), decipher.final()]);
  } catch { throw new Error('Incorrect password or damaged vault.'); }
  try { return validateData(JSON.parse(plaintext.toString('utf8'))); }
  finally { plaintext.fill(0); }
}

function encrypt(data, key, previous, previousHash, salt, profile = previous ? encryptionProfile(previous) : CURRENT) {
  const e = {
    format: 'harbor-vault', version: profile.version, id: previous?.id || crypto.randomUUID(), revision: (previous?.revision || 0) + 1,
    ancestors: previous ? [previousHash, ...previous.ancestors].slice(0, 128) : [],
    kdf: { ...profile.kdf }, cipher: 'aes-256-gcm', salt,
    iv: crypto.randomBytes(12).toString('base64'),
  };
  const cipher = crypto.createCipheriv('aes-256-gcm', key, decode(e.iv, 12, 'nonce'));
  cipher.setAAD(aad(e));
  const plaintext = Buffer.from(JSON.stringify(data));
  try { e.data = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'); }
  finally { plaintext.fill(0); }
  e.tag = cipher.getAuthTag().toString('base64');
  return { envelope: e, bytes: Buffer.from(JSON.stringify(e)), data };
}

async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function readFile(file) {
  if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Vault files must not be symbolic links.');
  const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES * 1.5) throw new Error('Invalid or oversized vault file.');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function atomicWrite(file, bytes, exclusive = false, createParent = true) {
  if (createParent) await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    if (exclusive) { await fs.link(temp, file); await fs.unlink(temp); }
    else { await fs.rename(temp, file); }
    // Windows does not support opening a directory for fsync. The file itself
    // is flushed above before the same-directory atomic rename/link.
    if (process.platform !== 'win32') {
      const dir = await fs.open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}

async function withFileLock(file, action, createParent = true) {
  if (createParent) await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { await fs.mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt >= 40) throw new Error('Vault is busy. If a previous process crashed, remove its .lock directory after closing Harbor.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  let failed = false;
  try { return await action(); }
  catch (error) { failed = true; throw error; }
  finally {
    // A disconnected sync folder can also make lock cleanup fail. Preserve
    // the original operation error rather than replacing it with rmdir's.
    try { await fs.rmdir(lock); } catch (error) { if (!failed) throw error; }
  }
}

async function withSharedLock(file, action) {
  try { return await withFileLock(file, action, false); }
  catch (error) {
    if (['ENOENT','ENOTDIR'].includes(error.code)) throw new Error('The sync folder or shared vault is unavailable. Reconnect it, then choose Sync now.');
    throw error;
  }
}

async function preserveRevision(folder, id, bytes) {
  // Immutable revisions also survive simultaneous writes by different devices
  // whose sync providers do not replicate advisory lock directories atomically.
  const file = path.join(folder, `${id}.history`, `${digest(bytes)}.harbor-vault`);
  // Only create the history child: never recreate an offline sync root.
  await fs.mkdir(path.dirname(file), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  try { await atomicWrite(file, bytes, true, false); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readFile(file)).equals(bytes)) throw new Error('An immutable sync revision was modified.');
  }
}

class Vault {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Vault path must be absolute.');
    this.path = filePath;
    this._key = null; this._data = null; this._envelope = null; this._hash = null; this._epoch = 0;
    this._queue = Promise.resolve();
    this._recoveryPreview = null;
    this.backupManagement = new (require('./backup-management.cjs').BackupManagement)(this, {readFile,parseEnvelope,derive,decrypt,encryptionProfile,digest,withFileLock,withSharedLock,collections:COLLECTIONS});
    this.retention = new (require('./backup-retention.cjs').BackupRetention)(this, {readFile,parseEnvelope,decrypt,digest,withFileLock,atomicWrite});
  }
  _serial(fn) { const result = this._queue.then(fn); this._queue = result.catch(() => {}); return result; }
  _unlocked() { if (!this._key || !this._data) throw new Error('Vault is locked.'); }
  _check(epoch) { if (epoch !== this._epoch) throw new Error('Vault was locked during the operation.'); }
  _adopt(e, bytes, data, key) {
    if (key && key !== this._key) { this._key?.fill(0); this._key = key; }
    this._envelope = e; this._hash = digest(bytes); this._data = data;
  }
  async _unchanged() {
    if (digest(await readFile(this.path)) !== this._hash) throw new Error('Vault changed on disk. Lock and unlock it before saving.');
  }
  async status() { return { exists: await exists(this.path), locked: !this._key, path: this.path }; }
  lock() { this.backupManagement.clear(); ++this._epoch; this._recoveryPreview = null; this._key?.fill(0); this._key = null; this._data = null; this._envelope = null; this._hash = null; }
  async _backupDirectory(create = false) {
    const directory = `${this.path}.backups`;
    if (create) await fs.mkdir(directory, {mode:0o700}).catch(error => { if(error.code !== 'EEXIST') throw error; });
    let stat;
    try { stat = await fs.lstat(directory); } catch(error) { if(error.code === 'ENOENT' && !create) return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The backup folder must be a local directory, not a symbolic link.');
    return directory;
  }
  async _backupFiles() {
    const directory = await this._backupDirectory();
    const entries = directory ? (await fs.readdir(directory)).filter(name => BACKUP_NAME.test(name)).map(name => {
      const [,at,reason] = name.match(BACKUP_NAME);
      return {id:`local:${name}`,file:path.join(directory,name),createdAt:Number(at),reason,legacy:false};
    }) : [];
    // Older imports used adjacent backup files. Offer them for recovery without
    // deleting or moving files created by previous versions.
    const prefix = `${path.basename(this.path)}.backup-`;
    const names = await fs.readdir(path.dirname(this.path)).catch(error => { if(error.code === 'ENOENT') return []; throw error; });
    for (const name of names) {
      const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
      if (LEGACY_BACKUP.test(suffix)) entries.push({id:`legacy:${suffix}`,file:path.join(path.dirname(this.path),name),createdAt:Number(suffix.match(LEGACY_BACKUP)[1]),reason:'import',legacy:true});
    }
    const regular = [];
    for (const entry of entries) {
      try {
        const stat = await fs.lstat(entry.file);
        if (stat.isFile() && !stat.isSymbolicLink()) regular.push({...entry,size:stat.size});
      } catch(error) { if(error.code !== 'ENOENT') throw error; }
    }
    return regular.sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id));
  }
  async _backupBytes(bytes, reason, protectedId = null) {
    const directory = await this._backupDirectory(true);
    const files = (await this._backupFiles()).filter(entry => !entry.legacy);
    // Monotonic timestamps keep retention deterministic during rapid writes.
    const at = Math.max(Date.now(), (files[0]?.createdAt || 0) + 1);
    const file = path.join(directory, `${at}-${crypto.randomUUID()}-${reason}.hbr`);
    await atomicWrite(file, bytes, true, false);
    await this.retention.prune([`local:${path.basename(file)}`,protectedId].filter(Boolean));
  }
  async _backupCurrent(reason, epoch) {
    const bytes = await readFile(this.path);
    this._check(epoch);
    await this._backupBytes(bytes, reason);
    this._check(epoch);
  }
  listBackups() {
    return this._serial(async () => { const retention=await this.retention.info(); return {limit:retention.policy.maxCount,retention,backups:(await this._backupFiles()).map(({file,...entry})=>({...entry,kept:retention.error?null:retention.kept.includes(entry.id)}))}; });
  }
  createBackup() {
    return this._serial(() => withFileLock(this.path, async () => {
      this._unlocked(); const epoch = this._epoch;
      await this._unchanged(); this._check(epoch);
      await this._backupCurrent('manual',epoch);
      return {created:true};
    }));
  }
  async _recoveryFile(id) {
    if (typeof id !== 'string') throw new Error('Choose a local backup.');
    const entry = (await this._backupFiles()).find(entry => entry.id === id);
    if (!entry) throw new Error('Backup is no longer available. Refresh the list.');
    return entry.file;
  }
  async _currentBytes() { return await exists(this.path) ? readFile(this.path) : null; }
  previewRecovery(id, password) {
    passwordCheck(password);
    const epoch = this._epoch;
    return this._serial(async () => {
      this._recoveryPreview = null; this._check(epoch);
      const bytes = await readFile(await this._recoveryFile(id)), e = parseEnvelope(bytes);
      const key = await derive(password,e.salt,encryptionProfile(e));
      try {
        const data = decrypt(e,key), current = await this._currentBytes(); this._check(epoch);
        const token = crypto.randomUUID();
        this._recoveryPreview = {token,id,sourceHash:digest(bytes),currentHash:current?digest(current):null,expires:Date.now()+5*60_000};
        return {token,revision:e.revision,counts:Object.fromEntries(COLLECTIONS.map(name=>[name,data[name].length])),knownHosts:Object.keys(data.knownHosts).length};
      } finally { key.fill(0); }
    });
  }
  restoreBackup(id, password, token) {
    passwordCheck(password);
    const epoch = this._epoch;
    return this._serial(() => withFileLock(this.path, async () => {
      this._check(epoch);
      const preview = this._recoveryPreview;
      if (!preview || preview.id !== id || preview.token !== token || preview.expires < Date.now()) throw new Error('Recovery preview expired. Preview the backup again.');
      const bytes = await readFile(await this._recoveryFile(id)), current = await this._currentBytes();
      if (digest(bytes) !== preview.sourceHash || (current?digest(current):null) !== preview.currentHash) throw new Error('The vault or backup changed. Preview the backup again.');
      const e = parseEnvelope(bytes); let key = await derive(password,e.salt,encryptionProfile(e));
      try {
        const data = decrypt(e,key); this._check(epoch);
        // A new branch from the recovered snapshot forces comparison with newer
        // shared data instead of silently pulling it over the recovered contents.
        const record = encrypt(data,key,e,digest(bytes),e.salt);
        if (current) await this._backupBytes(current,'recovery',id);
        this._check(epoch);
        const latest = await this._currentBytes(); this._check(epoch);
        if ((latest?digest(latest):null) !== preview.currentHash) throw new Error('The vault changed during recovery. Preview the backup again.');
        await atomicWrite(this.path,record.bytes); this._check(epoch);
        this._adopt(record.envelope,record.bytes,data,key); key = null;
        this._recoveryPreview = null;
        return clone(data);
      } finally { key?.fill(0); }
    }));
  }
  create(password) {
    passwordCheck(password, true);
    const epoch = this._epoch;
    return this._serial(() => withFileLock(this.path, async () => {
      this._check(epoch);
      if (await exists(this.path)) throw new Error('A vault already exists.');
      const salt = crypto.randomBytes(32).toString('base64');
      let key = await derive(password, salt);
      try {
        this._check(epoch);
        const record = encrypt(initialData(), key, null, null, salt);
        await atomicWrite(this.path, record.bytes, true); this._check(epoch);
        this._adopt(record.envelope, record.bytes, record.data, key); key = null;
        return clone(this._data);
      } finally { key?.fill(0); }
    }));
  }
  unlock(password) {
    passwordCheck(password);
    const epoch = this._epoch;
    return this._serial(async () => {
      this._check(epoch);
      const bytes = await readFile(this.path), e = parseEnvelope(bytes);
      let key = await derive(password, e.salt, encryptionProfile(e));
      try {
        const data = decrypt(e, key); this._check(epoch);
        this._adopt(e, bytes, data, key); key = null; return clone(data);
      } finally { key?.fill(0); }
    });
  }
  read() { return this._serial(() => { this._unlocked(); return clone(this._data); }); }
  save(data) {
    // Snapshot immediately so caller mutations cannot alter a queued write.
    const snapshot = validateData(data);
    return this._serial(() => withFileLock(this.path, async () => {
      this._unlocked(); const epoch = this._epoch;
      await this._unchanged(); this._check(epoch);
      const record = encrypt(snapshot, this._key, this._envelope, this._hash, this._envelope.salt);
      await this._backupCurrent('save',epoch);
      await atomicWrite(this.path, record.bytes); this._check(epoch);
      this._adopt(record.envelope, record.bytes, record.data); return clone(record.data);
    }));
  }
  encryptionInfo() {
    return this._serial(() => {
      this._unlocked();
      const profile = encryptionProfile(this._envelope);
      return {version:profile.version, needsUpgrade:profile !== CURRENT};
    });
  }
  upgradeEncryption(password) {
    passwordCheck(password);
    const epoch = this._epoch;
    return this._serial(() => withFileLock(this.path, async () => {
      this._unlocked(); this._check(epoch);
      await this._unchanged(); this._check(epoch);
      const previous = this._envelope, hash = this._hash;
      let oldKey, key;
      try {
        oldKey = await derive(password, previous.salt, encryptionProfile(previous));
        const data = decrypt(previous, oldKey); this._check(epoch);
        if (encryptionProfile(previous) === CURRENT) return {changed:false};
        // Keeping this random salt lets devices independently upgrading the same
        // vault derive the same new key and still compare divergent revisions.
        key = await derive(password, previous.salt, CURRENT); this._check(epoch);
        const record = encrypt(data, key, previous, hash, previous.salt, CURRENT);
        await this._backupCurrent('upgrade',epoch);
        await this._unchanged(); this._check(epoch);
        await atomicWrite(this.path, record.bytes); this._check(epoch);
        this._adopt(record.envelope, record.bytes, data, key); key = null;
        return {changed:true};
      } finally { oldKey?.fill(0); key?.fill(0); }
    }));
  }
  changePassword(oldPassword, newPassword) {
    passwordCheck(oldPassword); passwordCheck(newPassword, true);
    return this._serial(() => withFileLock(this.path, async () => {
      this._unlocked(); const epoch = this._epoch;
      await this._unchanged(); this._check(epoch);
      const previous = this._envelope, hash = this._hash, data = clone(this._data);
      let oldKey, key;
      try {
        oldKey = await derive(oldPassword, previous.salt, encryptionProfile(previous)); decrypt(previous, oldKey); this._check(epoch);
        const salt = crypto.randomBytes(32).toString('base64'); key = await derive(newPassword, salt); this._check(epoch);
        const record = encrypt(data, key, previous, hash, salt, CURRENT);
        await this._backupCurrent('password',epoch);
        await atomicWrite(this.path, record.bytes); this._check(epoch);
        this._adopt(record.envelope, record.bytes, data, key); key = null;
        return { changed: true };
      } finally { oldKey?.fill(0); key?.fill(0); }
    }));
  }
  exportTo(destination) {
    if (!path.isAbsolute(destination) || path.resolve(destination) === path.resolve(this.path)) throw new Error('Choose a different absolute export path.');
    return this._serial(async () => {
      const bytes = await readFile(this.path); parseEnvelope(bytes);
      await atomicWrite(destination, bytes, true);
      return { path: destination, encrypted: true };
    });
  }
  importFrom(source, password, replace = false) {
    passwordCheck(password);
    const epoch = this._epoch;
    return this._serial(() => withFileLock(this.path, async () => {
      this._check(epoch);
      if (await exists(this.path) && replace !== true) throw new Error('A vault already exists. Explicit replacement is required.');
      const bytes = await readFile(source), e = parseEnvelope(bytes);
      let key = await derive(password, e.salt, encryptionProfile(e));
      try {
        const data = decrypt(e, key); this._check(epoch);
        if (await exists(this.path)) {
          await this._backupCurrent('import',epoch);
        }
        this._check(epoch); await atomicWrite(this.path, bytes); this._check(epoch);
        this._adopt(e, bytes, data, key); key = null; return clone(data);
      } finally { key?.fill(0); }
    }));
  }
  sync(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Sync folder must be absolute.');
    return this._serial(() => withFileLock(this.path, async () => {
      this._unlocked(); const epoch = this._epoch;
      await this._unchanged(); this._check(epoch);
      const remote = path.join(folder, `${this._envelope.id}.harbor-vault`);
      if (path.resolve(remote) === path.resolve(this.path)) throw new Error('Choose a sync folder separate from the local vault.');
      return withSharedLock(remote, async () => {
        this._check(epoch);
        const localBytes = await readFile(this.path); this._check(epoch);
        await preserveRevision(folder, this._envelope.id, localBytes); this._check(epoch);
        if (!(await exists(remote))) {
          this._check(epoch); await atomicWrite(remote, localBytes, true, false); this._check(epoch);
          return { status: 'pushed', path: remote, revision: this._envelope.revision };
        }
        const remoteBytes = await readFile(remote), remoteHash = digest(remoteBytes);
        this._check(epoch);
        if (remoteHash === this._hash) return { status: 'unchanged', path: remote, revision: this._envelope.revision };
        const remoteEnvelope = parseEnvelope(remoteBytes);
        if (remoteEnvelope.id !== this._envelope.id) throw new Error('Sync vault identity does not match.');
        // A hash in our authenticated local ancestry proves this exact remote
        // file is an older copy, including when we just rotated the password.
        if (this._envelope.ancestors.includes(remoteHash)) {
          await preserveRevision(folder, this._envelope.id, remoteBytes); this._check(epoch);
          await atomicWrite(remote, localBytes, false, false); this._check(epoch);
          return { status: 'pushed', path: remote, revision: this._envelope.revision };
        }
        // Authenticate remote ancestry before allowing it to replace local data.
        let remoteData;
        try { remoteData = decrypt(remoteEnvelope, this._key); }
        catch { throw new Error('The sync vault cannot be authenticated. Its password may have changed or its protection was upgraded. Update Harbor on all devices, then upgrade this vault with its password or import the shared vault with its current password.'); }
        await preserveRevision(folder, this._envelope.id, remoteBytes); this._check(epoch);
        if (remoteEnvelope.ancestors.includes(this._hash)) {
          await this._backupCurrent('sync',epoch);
          await atomicWrite(this.path, remoteBytes); this._check(epoch);
          this._adopt(remoteEnvelope, remoteBytes, remoteData);
          return { status: 'pulled', path: remote, revision: remoteEnvelope.revision, data: clone(remoteData) };
        }
        const conflictPath = path.join(folder, `${this._envelope.id}.conflict-${Date.now()}-${crypto.randomUUID()}.harbor-vault`);
        await atomicWrite(conflictPath, localBytes, true, false); this._check(epoch);
        return { status: 'conflict', path: remote, conflictPath, revision: this._envelope.revision, message: 'Both copies changed. The shared vault is unchanged; your encrypted local copy was preserved separately. Import the desired copy to resolve.' };
      });
    }));
  }
  compareSync(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Sync folder must be absolute.');
    return this._serial(() => withFileLock(this.path, async () => {
      this._unlocked(); const epoch=this._epoch;
      await this._unchanged(); this._check(epoch);
      const remote=path.join(folder, `${this._envelope.id}.harbor-vault`);
      return withSharedLock(remote, async () => {
        const bytes=await readFile(remote), envelope=parseEnvelope(bytes), remoteHash=digest(bytes); this._check(epoch);
        if(envelope.id!==this._envelope.id)throw new Error('Sync vault identity does not match.');
        const remoteData=decrypt(envelope,this._key);
        if(remoteHash===this._hash||this._envelope.ancestors.includes(remoteHash)||envelope.ancestors.includes(this._hash))throw new Error('The copies no longer conflict. Sync again to get the current version.');
        return {token:this._hash+':'+remoteHash,localRevision:this._envelope.revision,remoteRevision:envelope.revision,rows:compareData(this._data,remoteData)};
      });
    }));
  }
  resolveSync(folder, choice) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Sync folder must be absolute.');
    if (!['local', 'remote'].includes(choice) && (!choice || typeof choice!=='object' || typeof choice.token!=='string')) throw new Error('Choose versions from the conflict comparison.');
    return this._serial(() => withFileLock(this.path, async () => {
      this._unlocked(); const epoch = this._epoch;
      await this._unchanged(); this._check(epoch);
      const remote = path.join(folder, `${this._envelope.id}.harbor-vault`);
      if (path.resolve(remote) === path.resolve(this.path)) throw new Error('Choose a sync folder separate from the local vault.');
      return withSharedLock(remote, async () => {
        this._check(epoch);
        const localBytes = await readFile(this.path), remoteBytes = await readFile(remote);
        this._check(epoch);
        const remoteHash = digest(remoteBytes), remoteEnvelope = parseEnvelope(remoteBytes);
        if (remoteEnvelope.id !== this._envelope.id) throw new Error('Sync vault identity does not match.');
        let remoteData;
        try { remoteData = decrypt(remoteEnvelope, this._key); }
        catch { throw new Error('The sync vault cannot be authenticated. Its password may have changed or its protection was upgraded. Update Harbor on all devices, then upgrade this vault with its password or import the shared vault with its current password.'); }
        if(typeof choice==='object'&&choice.token!==this._hash+':'+remoteHash)throw new Error('A vault changed since this comparison. Refresh the comparison before applying choices.');
        const chosenData=typeof choice==='object' ? validateData(mergeChoices(this._data,remoteData,choice.selections)) : clone(choice==='local'?this._data:remoteData);
        await preserveRevision(folder, this._envelope.id, localBytes);
        await preserveRevision(folder, this._envelope.id, remoteBytes); this._check(epoch);
        const ancestry = [remoteHash];
        // Interleave both branches so the bounded history retains recent
        // ancestors from each device. The current two heads always come first.
        for (let i = 0; i < 128; i++) {
          if (this._envelope.ancestors[i]) ancestry.push(this._envelope.ancestors[i]);
          if (remoteEnvelope.ancestors[i]) ancestry.push(remoteEnvelope.ancestors[i]);
        }
        const mergedParent = {
          ...this._envelope,
          revision: Math.max(this._envelope.revision, remoteEnvelope.revision),
          ancestors: [...new Set(ancestry)].filter(hash => hash !== this._hash),
        };
        const record = encrypt(chosenData, this._key, mergedParent, this._hash, this._envelope.salt);
        await preserveRevision(folder, this._envelope.id, record.bytes); this._check(epoch);
        await this._unchanged(); this._check(epoch);
        if (digest(await readFile(remote)) !== remoteHash) throw new Error('The shared vault changed during conflict resolution. Sync again before choosing a copy.');
        this._check(epoch);
        await this._backupCurrent('resolve',epoch);
        await atomicWrite(this.path, record.bytes); this._check(epoch);
        this._adopt(record.envelope, record.bytes, chosenData);
        if (digest(await readFile(remote)) !== remoteHash) throw new Error('The shared vault changed during conflict resolution. Your resolved copy is preserved locally; sync again.');
        this._check(epoch);
        await atomicWrite(remote, record.bytes, false, false); this._check(epoch);
        return { status: typeof choice==='object'?'resolved-items':`resolved-${choice}`, path: remote, revision: record.envelope.revision, data: clone(chosenData) };
      });
    }));
  }
}

module.exports = { Vault, initialData };
