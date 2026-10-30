'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Vault}=require('../electron/vault.cjs');
const password='upgrade-fixture-password';
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-retention-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const v=new Vault(path.join(dir,'vault.hbr'));await fs.copyFile(path.join(__dirname,'fixtures/upgrade-preview7-vault.json'),v.path);await v.unlock(password);return {dir,v,r:v.retention,m:v.backupManagement}}
async function save(r,maxCount=5,maxAgeDays=0){const s=await r.info();return r.setPolicy({maxCount,maxAgeDays},s.token,true)}
// Capture time once so slow writes cannot reverse the intended newest-first order.
async function copies(v,n,days=0,bytes){await fs.mkdir(v.path+'.backups',{recursive:true});const added=[],baseTime=Date.now()-days*86400000;for(let i=0;i<n;i++){const name=`${baseTime-i}-${crypto.randomUUID()}-manual.hbr`;await fs.writeFile(path.join(v.path+'.backups',name),bytes||await fs.readFile(v.path));added.push('local:'+name)}return added}
const file=(v,id)=>path.join(v.path+'.backups',id.slice(6));

test('default retention remains ten; count settings persist per device without rewriting vault/export',async t=>{
 const {dir,v,r}=await setup(t),before=await fs.readFile(v.path);assert.deepEqual((await r.info()).policy,{maxCount:10,maxAgeDays:0});
 await copies(v,14);await r.cleanup(false);assert.equal((await v.listBackups()).backups.length,10);
 await save(r,5);assert.equal((await v.listBackups()).backups.length,10);await v.createBackup();assert.equal((await v.listBackups()).backups.length,5);assert.deepEqual(await fs.readFile(v.path),before);
 const exported=path.join(dir,'export.hbr');await v.exportTo(exported);assert.deepEqual(await fs.readFile(exported),before);v.lock();const next=new Vault(v.path);await next.unlock(password);assert.equal((await next.retention.info()).policy.maxCount,5);
 if(process.platform!=='win32')assert.equal((await fs.stat(r.path)).mode&0o777,0o600);
});

test('policy confirmation, supported values and stale tokens are enforced',async t=>{
 const {r}=await setup(t);assert.throws(()=>r.setPolicy({maxCount:5,maxAgeDays:30},'missing',false),/Confirm/);
 for(const p of [{maxCount:0,maxAgeDays:0},{maxCount:4,maxAgeDays:0},{maxCount:10,maxAgeDays:1},{maxCount:'5',maxAgeDays:30},{maxCount:5,maxAgeDays:30,anything:true},null])assert.throws(()=>r.setPolicy(p,'missing',true),/supported/);
 const state=await r.info();await save(r,20,90);await assert.rejects(r.setPolicy({maxCount:5,maxAgeDays:0},state.token,true),/changed/);
 assert.deepEqual((await r.info()).policy,{maxCount:20,maxAgeDays:90});
});

test('age and count combine while retaining at least three authenticated unmarked copies',async t=>{
 const {v,r}=await setup(t);await copies(v,8,60);await save(r,50,30);await r.cleanup();assert.equal((await v.listBackups()).backups.length,3);
 await copies(v,8,1);await save(r,5,90);await r.cleanup();assert.equal((await v.listBackups()).backups.length,5);
});

test('Keep is additional to the count, persists, blocks manual deletion, and can be removed safely',async t=>{
 const {v,r,m}=await setup(t);const ids=await copies(v,8,60);let list=await m.list('local');await m.setKeep(undefined,list.token,ids.at(-1),true);await save(r,5,30);await r.cleanup();
 const remaining=(await v.listBackups()).backups;assert.equal(remaining.length,4);assert(remaining.find(b=>b.id===ids.at(-1)).kept);
 list=await m.list('local');assert.equal(list.rows.find(b=>b.id===ids.at(-1)).canDelete,false);await assert.rejects(m.delete('local',undefined,list.token,[ids.at(-1)],true),/Keep/);
 const next=new Vault(v.path);await next.unlock(password);assert((await next.retention.info()).kept.includes(ids.at(-1)));
 list=await m.list('local');await m.setKeep(undefined,list.token,ids.at(-1),false);await r.cleanup();assert.equal((await v.listBackups()).backups.length,3);await assert.rejects(fs.access(file(v,ids.at(-1))),{code:'ENOENT'});
});

test('insufficient authenticated copies pause cleanup; tampered headers do not satisfy the safety minimum',async t=>{
 const {v,r}=await setup(t);await save(r,5,30);await copies(v,2,60);
 const e=JSON.parse(await fs.readFile(v.path));e.revision++;await copies(v,10,60,Buffer.from(JSON.stringify(e)));
 const result=await r.cleanup();assert.match(result.skipped,/three/);assert.equal((await v.listBackups()).backups.length,12);
});

test('after protection/password changes cleanup waits for three copies verifiable with the current key',async t=>{
 const {v,r}=await setup(t);await copies(v,8,60);await save(r,5,30);await v.upgradeEncryption(password);const retained=(await v.listBackups()).backups.length;await v.createBackup();await v.createBackup();assert.equal((await v.listBackups()).backups.length,retained+2);assert.match((await r.cleanup()).skipped,/three/);
 await v.createBackup();await r.cleanup();assert.equal((await v.listBackups()).backups.length,4); // three v2 copies plus the recent pre-upgrade copy
 await v.changePassword(password,'new secure test password');await v.createBackup();assert.match((await r.cleanup()).skipped,/three/);
});

test('legacy files, shared history, exports, malformed and other-vault copies are excluded from automatic cleanup',async t=>{
 const {dir,v,r}=await setup(t),legacy=v.path+'.backup-'+(Date.now()-100*86400000)+'-'+crypto.randomUUID(),shared=path.join(dir,'shared'),exported=path.join(dir,'old-export.hbr');await fs.copyFile(v.path,legacy);await fs.mkdir(shared);const sync=await v.sync(shared);await v.exportTo(exported);
 await copies(v,10,60);const malformed=await copies(v,1,90,Buffer.from('damaged'));const other=JSON.parse(await fs.readFile(v.path));other.id=crypto.randomUUID();const foreign=await copies(v,1,90,Buffer.from(JSON.stringify(other)));
 await save(r,5,30);await r.cleanup();for(const f of [legacy,sync.path,exported,file(v,malformed[0]),file(v,foreign[0])])await fs.access(f);assert.equal((await fs.readdir(shared)).filter(n=>n.endsWith('.history')).length,1);
});

test('unreadable retention settings pause cleanup and protected deletion without blocking fresh backups',async t=>{
 const {v,r,m}=await setup(t);await copies(v,12);await fs.writeFile(r.path,'invalid settings');const before=(await v.listBackups()).backups.length;
 await v.createBackup();assert.equal((await v.listBackups()).backups.length,before+1);assert((await r.info()).error);const list=await m.list('local');assert(list.rows.every(row=>row.kept===null&&!row.canDelete));await assert.rejects(m.delete('local',undefined,list.token,[list.rows[0].id],true),/paused/);
});

test('failed policy write leaves prior settings and markers intact',async t=>{
 const {r}=await setup(t);await save(r,20);const before=await fs.readFile(r.path),rename=fs.rename;
 t.mock.method(fs,'rename',async(from,to)=>{if(to===r.path)throw new Error('Simulated write failure');return rename(from,to)});
 await assert.rejects(save(r,5,30),/write failure/);assert.deepEqual(await fs.readFile(r.path),before);
});

test('cleanup stops on lock and reports partial filesystem failures without changing the active vault',async t=>{
 const {v,r}=await setup(t);await copies(v,10,60);await save(r,5,30);const before=await fs.readFile(v.path),unlink=fs.unlink;let removed=0;
 t.mock.method(fs,'unlink',async f=>{if(f.endsWith('.hbr')&&++removed===2)throw new Error('Permission denied');return unlink(f)});
 const result=await r.cleanup();assert.equal(result.deleted,1);assert.match(result.error,/Permission/);assert.deepEqual(await fs.readFile(v.path),before);t.mock.restoreAll();
 const decrypt=r.h.decrypt;t.mock.method(r.h,'decrypt',(...args)=>{const result=decrypt(...args);v.lock();return result});const stopped=await r.prune();assert.match(stopped.error,/locked/);assert.equal(stopped.deleted,0);
});

test('changing a retained safety copy or settings during cleanup prevents further deletions',async t=>{
 const {v,r}=await setup(t);const ids=await copies(v,9,60);await save(r,5,30);const unlink=fs.unlink;let changed=false;
 t.mock.method(fs,'unlink',async f=>{await unlink(f);if(!changed&&f.endsWith('.hbr')){changed=true;await fs.appendFile(file(v,ids[0]),' ')}});
 const result=await r.cleanup();assert.equal(result.deleted,1);assert.match(result.error,/changed/);assert.equal((await v.listBackups()).backups.length,8);
});
