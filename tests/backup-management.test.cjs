'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Vault}=require('../electron/vault.cjs');
const password='upgrade-fixture-password';
const fixture=path.join(__dirname,'fixtures/upgrade-preview7-vault.json');
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-backup-manager-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const v=new Vault(path.join(dir,'vault.hbr'));await fs.copyFile(fixture,v.path);await v.unlock(password);return {dir,v,m:v.backupManagement}}
async function local(v){await v.createBackup();return (await v.backupManagement.list('local')).rows[0]}
const legacyFile=v=>v.path+'.backup-'+Date.now()+'-'+crypto.randomUUID();

test('inventory separates legacy/local copies, labels unauthenticated protection and refreshes removed files',async t=>{
 const {v,m}=await setup(t);const old=await local(v),legacy=legacyFile(v);await fs.copyFile(v.path,legacy);await v.upgradeEncryption(password);await v.createBackup();
 const damaged=path.join(v.path+'.backups',`${Date.now()+1000}-${crypto.randomUUID()}-manual.hbr`);await fs.writeFile(damaged,'damaged');
 const list=await m.list('local');assert(list.rows.some(r=>r.source==='legacy'));assert(list.rows.some(r=>r.protection==='enhanced'));assert(list.rows.some(r=>r.protection==='earlier'));assert(list.rows.every(r=>r.verified===false));assert(list.rows.every(r=>r.location!==v.path));assert.equal(list.rows.find(r=>r.location===damaged).protection,'unknown');assert.equal(list.rows.find(r=>r.location===damaged).canDelete,true);
 assert(!JSON.stringify(list).includes('privateKey'));await fs.unlink(old.location);const refreshed=await m.list('local');assert(!refreshed.rows.some(r=>r.id===old.id));assert(refreshed.rows.some(r=>r.location===legacy));
});

test('verified preview authenticates protection and contents without restoring or unlocking another vault',async t=>{
 const {v,m}=await setup(t);await local(v);const list=await m.list('local'),id=list.rows[0].id,before=await fs.readFile(v.path);
 await assert.rejects(m.preview('local',undefined,list.token,id,'wrong'),/Incorrect password/);
 const p=await m.preview('local',undefined,list.token,id,password);assert.equal(p.verified,true);assert.equal(p.protection,'earlier');assert.equal(typeof p.counts.hosts,'number');assert.deepEqual(await fs.readFile(v.path),before);assert.equal((await m.list('local')).rows[0].verified,false);
 const e=JSON.parse(await fs.readFile(list.rows[0].location));e.version=2;e.kdf={name:'scrypt',N:131072,r:8,p:1};await fs.writeFile(list.rows[0].location,JSON.stringify(e));const tampered=await m.list('local');assert.equal(tampered.rows[0].protection,'enhanced');await assert.rejects(m.preview('local',undefined,tampered.token,id,password),/Incorrect password/);
});

test('deletion requires confirmation and exact current selections; active vault and exports survive',async t=>{
 const {dir,v,m}=await setup(t);await local(v);const list=await m.list('local'),id=list.rows[0].id,before=await fs.readFile(v.path),exported=path.join(dir,'manual-export.hbr');await v.exportTo(exported);
 assert.throws(()=>m.delete('local',undefined,list.token,[id],false),/Confirm/);
 for(const ids of [[],[id,id],['../../vault.hbr'],['local:../vault.hbr'],['history:any'],[exported]])await assert.rejects(m.delete('local',undefined,list.token,ids,true),/Select backups/);
 assert.equal((await m.delete('local',undefined,list.token,[id],true)).deleted.length,1);assert.equal((await v.listBackups()).backups.length,0);assert.deepEqual(await fs.readFile(v.path),before);assert.deepEqual(await fs.readFile(exported),before);
});

test('changed selections, expired snapshots and changed sync locations fail before any deletion',async t=>{
 const {v,m}=await setup(t);await local(v);await local(v);let list=await m.list('local'),ids=list.rows.map(r=>r.id);await fs.appendFile(list.rows[1].location,' ');
 await assert.rejects(m.delete('local',undefined,list.token,ids,true),/changed/);await fs.access(list.rows[0].location);
 list=await m.list('local');m.snapshots.get('local').expires=0;await assert.rejects(m.delete('local',undefined,list.token,[list.rows[0].id],true),/expired/);
 list=await m.list('local');await assert.rejects(m.delete('local','different-folder',list.token,[list.rows[0].id],true),/expired/);
});

test('shared inventory is scoped to this vault history/conflicts, and deletion preserves active and unrelated files',async t=>{
 const {dir,v,m}=await setup(t),folder=path.join(dir,'shared');await fs.mkdir(folder);const synced=await v.sync(folder),before=await fs.readFile(synced.path),vaultId=JSON.parse(before).id;
 const conflict=path.join(folder,`${vaultId}.conflict-${Date.now()}-${crypto.randomUUID()}.harbor-vault`);await fs.writeFile(conflict,before);
 const unrelated=path.join(folder,`${crypto.randomUUID()}.conflict-${Date.now()}-${crypto.randomUUID()}.harbor-vault`);await fs.writeFile(unrelated,before);
 const exported=path.join(folder,'my-export.hbr');await fs.writeFile(exported,before);
 const list=await m.list('shared',folder);assert.equal(list.rows.length,2);assert.deepEqual(new Set(list.rows.map(r=>r.source)),new Set(['history','conflict']));assert(!list.rows.some(r=>r.location===synced.path));
 const p=await m.preview('shared',folder,list.token,list.rows[0].id,password);assert.equal(p.verified,true);
 const result=await m.delete('shared',folder,list.token,list.rows.map(r=>r.id),true);assert.equal(result.deleted.length,2);assert.equal(result.error,null);assert.deepEqual(await fs.readFile(synced.path),before);assert.deepEqual(await fs.readFile(v.path),before);await fs.access(unrelated);await fs.access(exported);assert.equal((await m.list('shared',folder)).rows.length,0);
});

test('disconnected shared folder is not recreated and does not affect local management',async t=>{
 const {dir,v,m}=await setup(t),folder=path.join(dir,'shared');await fs.mkdir(folder);await v.sync(folder);const list=await m.list('shared',folder);await fs.rename(folder,folder+'-offline');
 await assert.rejects(m.delete('shared',folder,list.token,list.rows.map(r=>r.id),true),/unavailable/);await assert.rejects(fs.access(folder),{code:'ENOENT'});await local(v);assert((await m.list('local',folder)).rows.length>0);await fs.writeFile(folder,'not a directory');assert((await m.list('local',folder)).rows.length>0);
});

test('symlink files, replaced backup directories and active-vault hardlinks cannot become deletion targets',{skip:process.platform==='win32'},async t=>{
 const {dir,v,m}=await setup(t);await local(v);const name=`${Date.now()+20}-${crypto.randomUUID()}-manual.hbr`,link=path.join(v.path+'.backups',name);await fs.symlink(v.path,link);const hard=path.join(v.path+'.backups',`${Date.now()+30}-${crypto.randomUUID()}-manual.hbr`);await fs.link(v.path,hard);
 const list=await m.list('local');assert.equal(list.rows.length,1);await fs.unlink(link);await fs.unlink(hard);await fs.rename(v.path+'.backups',path.join(dir,'moved'));await fs.symlink(path.join(dir,'moved'),v.path+'.backups');
 await assert.rejects(m.delete('local',undefined,list.token,[list.rows[0].id],true),/symbolic link/);await fs.access(v.path);await fs.access(path.join(dir,'moved',list.rows[0].name));
});

test('partial deletion reports exactly what was removed and invalidates restoration preview',async t=>{
 const {v,m}=await setup(t);await local(v);await local(v);const list=await m.list('local');await v.previewRecovery(list.rows[0].id,password);let count=0;const unlink=fs.unlink;
 t.mock.method(fs,'unlink',async file=>{if(file.endsWith('.hbr')&&++count===2)throw new Error('Simulated permission failure');return unlink(file)});
 const result=await m.delete('local',undefined,list.token,list.rows.map(r=>r.id),true);assert.equal(result.deleted.length,1);assert.equal(result.remaining.length,1);assert.match(result.error,/permission/);assert.equal(v._recoveryPreview,null);assert.equal((await m.list('local')).rows.length,1);
});

test('locking invalidates management tokens and clears temporary preview keys',async t=>{
 const {v,m}=await setup(t);await local(v);const list=await m.list('local');const derive=m.h.derive;let key;
 t.mock.method(m.h,'derive',async(...args)=>{key=await derive(...args);v.lock();return key});
 await assert.rejects(m.preview('local',undefined,list.token,list.rows[0].id,password),/locked/);assert(key.every(x=>x===0));assert.equal(m.snapshots.size,0);await assert.rejects(m.delete('local',undefined,list.token,[list.rows[0].id],true),/locked/);await fs.access(list.rows[0].location);
});

test('refresh invalidates prior selections and a replaced inode cannot be deleted with an old token',async t=>{
 const {v,m}=await setup(t);await local(v);const old=await m.list('local'),fresh=await m.list('local');await assert.rejects(m.delete('local',undefined,old.token,[old.rows[0].id],true),/expired/);
 const file=fresh.rows[0].location;await fs.rename(file,file+'.original');await fs.copyFile(file+'.original',file);await assert.rejects(m.delete('local',undefined,fresh.token,[fresh.rows[0].id],true),/changed/);await fs.access(file);
});

test('large histories are bounded and selections cannot target a file outside the displayed inventory',async t=>{
 const {dir,v,m}=await setup(t),folder=path.join(dir,'shared');await fs.mkdir(folder);const synced=await v.sync(folder),bytes=await fs.readFile(v.path),vaultId=JSON.parse(bytes).id,history=path.join(folder,vaultId+'.history');
 for(let i=0;i<201;i++)await fs.writeFile(path.join(history,i.toString(16).padStart(64,'0')+'.harbor-vault'),bytes);
 const list=await m.list('shared',folder);assert.equal(list.limit,200);assert.equal(list.truncated,true);assert.equal(list.rows.length,200);
 const omitted=(await fs.readdir(history)).find(name=>!list.rows.some(row=>row.name===name));assert(omitted);await assert.rejects(m.delete('shared',folder,list.token,['history:'+omitted],true),/Select backups/);assert.deepEqual(await fs.readFile(synced.path),bytes);
});
