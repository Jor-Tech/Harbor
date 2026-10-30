'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {promisify}=require('node:util');
const {Vault}=require('../electron/vault.cjs');
const password='upgrade-fixture-password',fixture=path.join(__dirname,'fixtures/upgrade-preview7-vault.json');
const strong={name:'scrypt',N:131072,r:8,p:1};
async function setup(t,legacy=true){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-protection-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const vault=new Vault(path.join(dir,'vault.hbr'));if(legacy){await fs.copyFile(fixture,vault.path);await vault.unlock(password)}else await vault.create(password);return {dir,vault}}
async function envelope(v){return JSON.parse(await fs.readFile(v.path,'utf8'))}
async function verifyStrong(v,pw=password){const e=await envelope(v);assert.equal(e.version,2);assert.deepEqual(e.kdf,strong);const key=await promisify(crypto.scrypt)(pw,Buffer.from(e.salt,'base64'),32,{N:131072,r:8,p:1,maxmem:256*1024*1024});try{const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));d.setAAD(Buffer.from(JSON.stringify({format:e.format,version:e.version,id:e.id,revision:e.revision,ancestors:e.ancestors,kdf:e.kdf,cipher:e.cipher,salt:e.salt})));d.setAuthTag(Buffer.from(e.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data,'base64')),d.final()]).toString())}finally{key.fill(0)}}

test('new vault and password rotation use OWASP scrypt, never relabel a legacy-derived key',async t=>{
 const {vault}=await setup(t,false);await verifyStrong(vault);assert.deepEqual(await vault.encryptionInfo(),{version:2,needsUpgrade:false});
 const legacy=new Vault(path.join(path.dirname(vault.path),'legacy.hbr'));await fs.copyFile(fixture,legacy.path);const d=await legacy.unlock(password);await legacy.changePassword(password,'a new strong test password');assert.deepEqual(await verifyStrong(legacy,'a new strong test password'),d);legacy.lock();await assert.rejects(legacy.unlock(password),/Incorrect password/);
});

test('explicit upgrade preserves all legacy contents, backup, password, identity and sync salt',async t=>{
 const {dir,vault}=await setup(t),before=await fs.readFile(vault.path),old=await envelope(vault),data=await vault.read(),oldKey=vault._key;
 assert.deepEqual(await vault.encryptionInfo(),{version:1,needsUpgrade:true});assert.deepEqual(before,await fs.readFile(fixture));
 await assert.rejects(vault.upgradeEncryption('wrong password'),/Incorrect password/);assert.deepEqual(await fs.readFile(vault.path),before);
 assert.deepEqual(await vault.upgradeEncryption(password),{changed:true});assert.deepEqual(await verifyStrong(vault),data);assert(oldKey.every(x=>x===0));
 const current=await envelope(vault);assert.equal(current.salt,old.salt);assert.equal(current.id,old.id);assert.equal(current.revision,old.revision+1);assert.notEqual(current.iv,old.iv);assert(current.ancestors.includes(crypto.createHash('sha256').update(before).digest('hex')));
 const backup=(await vault.listBackups()).backups[0];assert.equal(backup.reason,'upgrade');assert.deepEqual(await fs.readFile(path.join(vault.path+'.backups',backup.id.slice(6))),before);
 const upgraded=await fs.readFile(vault.path);assert.deepEqual(await vault.upgradeEncryption(password),{changed:false});assert.deepEqual(await fs.readFile(vault.path),upgraded);
 const exported=path.join(dir,'export.hbr');await vault.exportTo(exported);assert.deepEqual(await fs.readFile(exported),upgraded);
 vault.lock();await assert.rejects(vault.encryptionInfo(),/locked/);assert.deepEqual(await vault.unlock(password),data);
 const preview=await vault.previewRecovery(backup.id,password);await vault.restoreBackup(backup.id,password,preview.token);assert.deepEqual(await vault.read(),data);assert.equal((await vault.encryptionInfo()).needsUpgrade,true);await vault.upgradeEncryption(password);await verifyStrong(vault);
});

test('unknown, mixed, huge and additional KDF fields are rejected; valid-profile relabeling fails GCM',async t=>{
 const {vault}=await setup(t,false),original=await envelope(vault);vault.lock();
 for(const mutate of [e=>e.kdf.N=2**30,e=>e.kdf.p=3,e=>e.kdf.maxmem=2**40,e=>e.version=1,e=>e.version=3,e=>e.kdf=null]){
  const e=structuredClone(original);mutate(e);await fs.writeFile(vault.path,JSON.stringify(e));await assert.rejects(vault.unlock(password),/Unsupported vault/);assert.equal((await vault.status()).locked,true);
 }
 const e=structuredClone(original);e.version=1;e.kdf={name:'scrypt',N:32768,r:8,p:1};await fs.writeFile(vault.path,JSON.stringify(e));await assert.rejects(vault.unlock(password),/Incorrect password/);
});

test('upgrade write failure keeps readable legacy bytes and zeroes the unadopted strong key',async t=>{
 const {vault}=await setup(t),before=await fs.readFile(vault.path),oldKey=vault._key;const rename=fs.rename,cipher=crypto.createCipheriv;let pendingKey;
 t.mock.method(crypto,'createCipheriv',(...args)=>{pendingKey=args[1];return cipher(...args)});
 t.mock.method(fs,'rename',async(from,to)=>{if(to===vault.path)throw new Error('Simulated write failure');return rename(from,to)});
 await assert.rejects(vault.upgradeEncryption(password),/write failure/);assert.deepEqual(await fs.readFile(vault.path),before);assert.equal(vault._key,oldKey);assert(pendingKey.every(x=>x===0));assert.equal((await vault.encryptionInfo()).needsUpgrade,true);await vault.read();
});

test('locking during upgrade prevents replacement and clears both key buffers',async t=>{
 const {vault}=await setup(t),before=await fs.readFile(vault.path),oldKey=vault._key,cipher=crypto.createCipheriv;let pendingKey;
 t.mock.method(crypto,'createCipheriv',(...args)=>{pendingKey=args[1];const result=cipher(...args);vault.lock();return result});
 await assert.rejects(vault.upgradeEncryption(password),/locked during/);assert.deepEqual(await fs.readFile(vault.path),before);assert(oldKey.every(x=>x===0));assert(pendingKey.every(x=>x===0));assert.equal((await vault.status()).locked,true);
});

test('independent device upgrades keep conflict review possible and cross-profile sync fails closed',async t=>{
 const {dir,vault:a}=await setup(t),folder=path.join(dir,'shared');await fs.mkdir(folder);const initial=await a.sync(folder);const b=new Vault(path.join(dir,'b.hbr'));await b.importFrom(initial.path,password);
 let d=await a.read();d.settings.fontSize=20;await a.save(d);d=await b.read();d.settings.fontSize=24;await b.save(d);
 await a.upgradeEncryption(password);await a.sync(folder);const before=await fs.readFile(b.path),shared=await fs.readFile(initial.path);
 await assert.rejects(b.sync(folder),/protection was upgraded/);assert.deepEqual(await fs.readFile(b.path),before);assert.deepEqual(await fs.readFile(initial.path),shared);
 await b.upgradeEncryption(password);assert.equal((await b.sync(folder)).status,'conflict');const compare=await b.compareSync(folder);await b.resolveSync(folder,{token:compare.token,selections:compare.rows.map(row=>({key:row.key,side:'local'}))});assert.equal((await a.sync(folder)).status,'pulled');assert.equal((await a.read()).settings.fontSize,24);await verifyStrong(a);await verifyStrong(b);
});
