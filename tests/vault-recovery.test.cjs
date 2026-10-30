'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Vault}=require('../electron/vault.cjs');
const password='recovery-test-password', nextPassword='changed-recovery-password';
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-recovery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const vault=new Vault(path.join(dir,'vault.hbr'));return {dir,vault}}
async function seed(vault){const d=await vault.create(password);d.hosts.push({id:'secret-host',label:'Private server',address:'example.test',port:22,password:'hidden-credential'});await vault.save(d);return d}
async function snapshot(vault){await vault.createBackup();return (await vault.listBackups()).backups[0]}
const fileFor=(v,b)=>path.join(v.path+'.backups',b.id.slice('local:'.length));

test('automatic local backups are encrypted, bounded and preserve the version before each write',async t=>{
 const {vault}=await setup(t);const d=await seed(vault);let previous=await fs.readFile(vault.path);
 for(let i=0;i<14;i++){d.settings.fontSize=12+i;await vault.save(d);const list=await vault.listBackups();assert(list.backups.length<=10);assert.deepEqual(await fs.readFile(fileFor(vault,list.backups[0])),previous);previous=await fs.readFile(vault.path)}
 const list=await vault.listBackups();assert.equal(list.limit,10);assert.equal(list.backups.length,10);
 for(const b of list.backups){const bytes=await fs.readFile(fileFor(vault,b),'utf8');assert(!bytes.includes('hidden-credential'));assert(!bytes.includes('Private server'));if(process.platform!=='win32')assert.equal((await fs.stat(fileFor(vault,b))).mode&0o777,0o600)}
 if(process.platform!=='win32')assert.equal((await fs.stat(vault.path+'.backups')).mode&0o777,0o700);
 assert(!JSON.stringify(list).includes('secret-host'));
});

test('recovery from a locked damaged vault verifies a preview and preserves the damaged bytes',async t=>{
 const {vault}=await setup(t);await seed(vault);const b=await snapshot(vault);vault.lock();await fs.writeFile(vault.path,'damaged encrypted file');
 const p=await vault.previewRecovery(b.id,password);assert.equal(p.counts.hosts,1);assert(!JSON.stringify(p).includes('Private server'));assert(!JSON.stringify(p).includes('hidden-credential'));
 assert.equal((await vault.status()).locked,true);
 const restored=await vault.restoreBackup(b.id,password,p.token);assert.equal(restored.hosts[0].password,'hidden-credential');
 const copies=(await vault.listBackups()).backups;assert.equal(copies[0].reason,'recovery');assert.equal(await fs.readFile(fileFor(vault,copies[0]),'utf8'),'damaged encrypted file');
 vault.lock();assert.equal((await vault.unlock(password)).hosts.length,1);
});

test('a missing current vault can be recovered without creating a new unrelated vault',async t=>{
 const {vault}=await setup(t);await seed(vault);const b=await snapshot(vault);const original=JSON.parse(await fs.readFile(vault.path,'utf8'));vault.lock();await fs.unlink(vault.path);
 const p=await vault.previewRecovery(b.id,password);await vault.restoreBackup(b.id,password,p.token);const restored=JSON.parse(await fs.readFile(vault.path,'utf8'));assert.equal(restored.id,original.id);assert.equal(restored.revision,original.revision+1);
});

test('wrong passwords, tampered snapshots, invalid ids and missing previews never replace the vault',async t=>{
 const {vault}=await setup(t);await seed(vault);const b=await snapshot(vault),before=await fs.readFile(vault.path);vault.lock();
 await assert.rejects(vault.previewRecovery(b.id,'incorrect-password'),/Incorrect password/);
 await assert.rejects(vault.previewRecovery('local:../../vault.hbr',password),/no longer available/);
 await assert.rejects(vault.restoreBackup(b.id,password,'invented-token'),/preview expired/);
 const p=await vault.previewRecovery(b.id,password);await assert.rejects(vault.restoreBackup(b.id,'incorrect-password',p.token),/Incorrect password/);
 const envelope=JSON.parse(await fs.readFile(fileFor(vault,b),'utf8'));envelope.revision++;await fs.writeFile(fileFor(vault,b),JSON.stringify(envelope));
 await assert.rejects(vault.restoreBackup(b.id,password,p.token),/changed/);
 await assert.rejects(vault.previewRecovery(b.id,password),/Incorrect password/);
 assert.deepEqual(await fs.readFile(vault.path),before);
});

test('edits, expiry and locking invalidate a recovery preview',async t=>{
 const {vault}=await setup(t);const d=await seed(vault),b=await snapshot(vault);
 let p=await vault.previewRecovery(b.id,password);d.settings.fontSize=20;await vault.save(d);
 await assert.rejects(vault.restoreBackup(b.id,password,p.token),/changed/);
 p=await vault.previewRecovery(b.id,password);vault._recoveryPreview.expires=0;await assert.rejects(vault.restoreBackup(b.id,password,p.token),/expired/);
 p=await vault.previewRecovery(b.id,password);vault.lock();await assert.rejects(vault.restoreBackup(b.id,password,p.token),/expired/);
});

test('password rotation keeps an old-password snapshot and recovery preserves the current-password copy',async t=>{
 const {vault}=await setup(t);await seed(vault);await vault.changePassword(password,nextPassword);
 const b=(await vault.listBackups()).backups[0];assert.equal(b.reason,'password');
 await assert.rejects(vault.previewRecovery(b.id,nextPassword),/Incorrect password/);
 const p=await vault.previewRecovery(b.id,password);await vault.restoreBackup(b.id,password,p.token);
 const newer=(await vault.listBackups()).backups[0];assert.equal(newer.reason,'recovery');const n=await vault.previewRecovery(newer.id,nextPassword);assert.equal(n.counts.hosts,1);
});

test('backup failure prevents changing the only current copy',async t=>{
 const {vault}=await setup(t);const d=await seed(vault),before=await fs.readFile(vault.path),open=fs.open;
 t.mock.method(fs,'open',async(file,...args)=>{if(String(file).includes('.backups')&&String(file).endsWith('.tmp'))throw Object.assign(new Error('Disk full'),{code:'ENOSPC'});return open(file,...args)});
 d.hosts=[];await assert.rejects(vault.save(d),/Disk full/);assert.deepEqual(await fs.readFile(vault.path),before);assert.equal((await vault.read()).hosts.length,1);
});

test('an interrupted atomic replacement leaves a usable current file and backup',async t=>{
 const {vault}=await setup(t);const d=await seed(vault),before=await fs.readFile(vault.path),rename=fs.rename;
 t.mock.method(fs,'rename',async(from,to)=>{if(to===vault.path)throw new Error('Simulated interruption before rename');return rename(from,to)});
 d.hosts=[];await assert.rejects(vault.save(d),/Simulated interruption/);assert.deepEqual(await fs.readFile(vault.path),before);
 const b=(await vault.listBackups()).backups[0];assert.deepEqual(await fs.readFile(fileFor(vault,b)),before);
 assert.equal((await fs.readdir(path.dirname(vault.path))).filter(n=>n.endsWith('.tmp')).length,0);
});

test('recovery write failure retains the current bytes and keeps the selected backup recoverable',async t=>{
 const {vault}=await setup(t);const d=await seed(vault),b=await snapshot(vault);d.hosts=[];await vault.save(d);for(let i=0;i<8;i++)await vault.createBackup();assert.equal((await vault.listBackups()).backups.at(-1).id,b.id);const before=await fs.readFile(vault.path),p=await vault.previewRecovery(b.id,password),rename=fs.rename;
 t.mock.method(fs,'rename',async(from,to)=>{if(to===vault.path)throw new Error('Cannot replace');return rename(from,to)});
 await assert.rejects(vault.restoreBackup(b.id,password,p.token),/Cannot replace/);assert.deepEqual(await fs.readFile(vault.path),before);
 assert.equal((await vault.previewRecovery(b.id,password)).counts.hosts,1);
});

test('sync pull and conflict resolution create local recovery points; restored history conflicts with newer shared data',async t=>{
 const {dir,vault}=await setup(t);const d=await seed(vault),b=await snapshot(vault),folder=path.join(dir,'shared');await fs.mkdir(folder);const pushed=await vault.sync(folder);
 const remote=new Vault(path.join(dir,'other.hbr'));await remote.importFrom(pushed.path,password);const r=await remote.read();r.hosts[0].label='Remote change';await remote.save(r);await remote.sync(folder);
 await vault.sync(folder);assert.equal((await vault.listBackups()).backups[0].reason,'sync');
 let p=await vault.previewRecovery(b.id,password);await vault.restoreBackup(b.id,password,p.token);
 assert.equal((await vault.sync(folder)).status,'conflict');assert.equal((await vault.read()).hosts[0].label,'Private server');
 await vault.resolveSync(folder,'remote');assert.equal((await vault.listBackups()).backups[0].reason,'resolve');
 const recovery=(await vault.listBackups()).backups[0];p=await vault.previewRecovery(recovery.id,password);await vault.restoreBackup(recovery.id,password,p.token);assert.equal((await vault.read()).hosts[0].label,'Private server');
});

test('legacy import backups remain available and are not pruned',async t=>{
 const {vault}=await setup(t);await seed(vault);const suffix=Date.now()+'-'+require('node:crypto').randomUUID(),legacy=vault.path+'.backup-'+suffix;await fs.copyFile(vault.path,legacy);
 for(let i=0;i<12;i++)await vault.createBackup();const list=await vault.listBackups();assert.equal(list.backups.filter(b=>!b.legacy).length,10);assert.equal(list.backups.filter(b=>b.legacy).length,1);
 const p=await vault.previewRecovery('legacy:'+suffix,password);assert.equal(p.counts.hosts,1);assert(await fs.stat(legacy));
});

test('symbolic-link backup directories and files are not followed', {skip:process.platform==='win32'},async t=>{
 const {dir,vault}=await setup(t);await seed(vault);const b=await snapshot(vault),target=path.join(dir,'external.hbr');await fs.copyFile(vault.path,target);await fs.unlink(fileFor(vault,b));await fs.symlink(target,fileFor(vault,b));
 await assert.rejects(vault.previewRecovery(b.id,password),/no longer available/);
 const moved=vault.path+'.old';await fs.rename(vault.path+'.backups',moved);await fs.symlink(moved,vault.path+'.backups');await assert.rejects(vault.createBackup(),/symbolic link/);
});

test('external changes and lock during recovery preparation prevent replacement',async t=>{
 const {vault}=await setup(t);await seed(vault);const b=await snapshot(vault),original=vault._backupBytes;
 let p=await vault.previewRecovery(b.id,password);
 const mock=t.mock.method(vault,'_backupBytes',async function(...args){await original.apply(this,args);await fs.writeFile(this.path,'external change')});
 await assert.rejects(vault.restoreBackup(b.id,password,p.token),/changed during recovery/);assert.equal(await fs.readFile(vault.path,'utf8'),'external change');mock.mock.restore();
 p=await vault.previewRecovery(b.id,password);
 t.mock.method(vault,'_backupBytes',async function(...args){await original.apply(this,args);this.lock()});
 await assert.rejects(vault.restoreBackup(b.id,password,p.token),/locked during/);assert.equal(await fs.readFile(vault.path,'utf8'),'external change');
});
