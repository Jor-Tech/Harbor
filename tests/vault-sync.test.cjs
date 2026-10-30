'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Vault,initialData}=require('../electron/vault.cjs');
const {compareData,mergeChoices}=require('../electron/vault-conflicts.cjs');
const {FolderSync}=require('../electron/folder-sync.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<100;n++){if(fn())return;await sleep(10)}assert.fail('Expected sync state did not arrive')}
async function copies(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-sync-compare-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const folder=path.join(root,'shared');await fs.mkdir(folder);
 const local=new Vault(path.join(root,'local.hbr')),remote=new Vault(path.join(root,'remote.hbr'));
 await local.create('comparison-test-password');let d=await local.read();d.hosts.push({id:'host',label:'Server',address:'server.test',port:22,password:'LOCAL_SECRET'});d.keys.push({id:'key',label:'Key',privateKey:'PRIVATE_KEY_SECRET'});await local.save(d);
 const push=await local.sync(folder);await remote.importFrom(push.path,'comparison-test-password');return {root,folder,local,remote,remotePath:push.path};
}
async function diverge(f){let a=await f.local.read(),b=await f.remote.read();a.hosts[0].label='Local server';a.snippets.push({id:'local-snippet',label:'Local command',command:'LOCAL_COMMAND_SECRET'});b.hosts[0].address='remote.test';b.hosts[0].password='REMOTE_SECRET';b.keys[0].privateKey='OTHER_PRIVATE_SECRET';b.settings.theme='light';await f.local.save(a);await f.remote.save(b);await f.remote.sync(f.folder);await f.local.sync(f.folder)}
test('comparison redacts credentials/commands and mixed choices reconcile both branches',async t=>{
 const f=await copies(t);await diverge(f);const preview=await f.local.compareSync(f.folder),text=JSON.stringify(preview);
 for(const secret of ['LOCAL_SECRET','REMOTE_SECRET','PRIVATE_KEY_SECRET','OTHER_PRIVATE_SECRET','LOCAL_COMMAND_SECRET'])assert(!text.includes(secret));assert(text.includes('Hidden value'));assert(text.includes('remote.test'));
 const result=await f.local.resolveSync(f.folder,{token:preview.token,selections:preview.rows.map(row=>({key:row.key,side:row.collection==='hosts'||row.collection==='settings'?'remote':'local'}))});assert.equal(result.status,'resolved-items');
 const d=await f.local.read();assert.equal(d.hosts[0].address,'remote.test');assert.equal(d.hosts[0].password,'REMOTE_SECRET');assert.equal(d.keys[0].privateKey,'PRIVATE_KEY_SECRET');assert.equal(d.snippets.length,1);assert.equal(d.settings.theme,'light');assert.equal((await f.remote.sync(f.folder)).status,'pulled');assert.deepEqual(await f.remote.read(),d);
 const encrypted=await fs.readFile(f.remotePath,'utf8');assert(!encrypted.includes('REMOTE_SECRET'));assert((await fs.readdir(path.join(f.folder,path.basename(f.remotePath,'.harbor-vault')+'.history'))).length>=4);
});
test('comparison choices reject either local or remote changes after preview without overwriting',async t=>{
 for(const side of ['local','remote']){const f=await copies(t);await diverge(f);const p=await f.local.compareSync(f.folder);const changed=await f[side].read();changed.settings.fontSize=18;await f[side].save(changed);if(side==='remote')await f.remote.sync(f.folder);
 const before=await fs.readFile(f.remotePath);await assert.rejects(f.local.resolveSync(f.folder,{token:p.token,selections:p.rows.map(r=>({key:r.key,side:'local'}))}),/changed since/);assert.deepEqual(await fs.readFile(f.remotePath),before);}
});
test('incomplete choices, dangling references, and tampered shared data are rejected',async t=>{
 const f=await copies(t);await diverge(f);const p=await f.local.compareSync(f.folder);await assert.rejects(f.local.resolveSync(f.folder,{token:p.token,selections:[]}),/every changed/);
 const envelope=JSON.parse(await fs.readFile(f.remotePath));envelope.ancestors.push('0'.repeat(64));await fs.writeFile(f.remotePath,JSON.stringify(envelope));await assert.rejects(f.local.compareSync(f.folder),/damaged/);
 const a=initialData(),b=initialData();a.hosts=[{id:'h',label:'Host',address:'test',keyId:'k'}];a.keys=[{id:'k',label:'Key',privateKey:'secret'}];b.hosts=a.hosts.map(h=>({...h,keyId:''}));const rows=compareData(a,b);assert.throws(()=>mergeChoices(a,b,rows.map(r=>({key:r.key,side:r.collection==='hosts'?'local':'remote'}))),/needs a key/);
});
test('item selection distinguishes absence, preserves unknown fields and requires every choice',()=>{
 const a=initialData(),b=initialData();a.snippets=[{id:'a',label:'Local',command:'a'}];b.snippets=[{id:'b',label:'Remote',command:'b'}];a.future={enabled:true};b.future={enabled:false};b.knownHosts['server:22']={fingerprint:'SHA256:public',algorithm:'ssh-ed25519'};
 const rows=compareData(a,b),result=mergeChoices(a,b,rows.map(r=>({key:r.key,side:r.label==='Local'?'local':'remote'})));assert.deepEqual(result.snippets.map(s=>s.id),['a','b']);assert.deepEqual(result.future,b.future);assert.deepEqual(result.knownHosts,b.knownHosts);
 assert.throws(()=>mergeChoices(a,b,[{key:rows[0].key,side:'local'}]),/every changed/);
});
test('scheduler is opt-in, coalesces edits, polls while unlocked and stops on lock',async t=>{
 let count=0;const s=new FolderSync({sync:async()=>{count++;return {result:{status:'unchanged'}}},intervalMs:50,debounceMs:10});t.after(()=>s.close());
 s.configure({unlocked:true});s.schedule();await sleep(30);assert.equal(count,0);
 s.configure({enabled:true});s.schedule();s.schedule();s.schedule();await until(()=>count===1);await until(()=>count>=2);s.configure({unlocked:false});const stopped=count;await sleep(80);assert.equal(count,stopped);assert.equal(s.state.phase,'locked');
});
test('conflicts and failures pause polling until an explicit retry succeeds',async t=>{
 for(const outcome of ['conflict','error']){let count=0,ok=false;const s=new FolderSync({sync:async()=>{count++;if(!ok&&outcome==='error')throw new Error('Folder unavailable');return {result:{status:ok?'unchanged':'conflict'}}},intervalMs:20,debounceMs:5});t.after(()=>s.close());s.configure({enabled:true,unlocked:true});await until(()=>s.state.phase===outcome);await sleep(70);assert.equal(count,1);ok=true;await s.run(true);assert.equal(s.state.phase,'idle');await until(()=>count>2);s.close();}
});
test('scheduler serializes in-flight requests and ignores completion after lock',async t=>{
 let release,count=0;const s=new FolderSync({sync:()=>{count++;return new Promise(r=>{release=r})},intervalMs:10000,debounceMs:5});t.after(()=>s.close());s.configure({enabled:true,unlocked:true});await until(()=>release);const manual=s.run(true);s.schedule();s.configure({unlocked:false});release({result:{status:'pushed'}});await manual;await sleep(30);assert.equal(count,1);assert.equal(s.state.phase,'locked');assert.equal(s.state.lastResult,undefined);
});
