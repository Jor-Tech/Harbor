'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Vault}=require('../electron/vault.cjs');
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-sync-disconnect-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const folder=path.join(root,'shared');await fs.mkdir(folder);
  const vault=new Vault(path.join(root,'local.hbr'));await vault.create('disconnect-test-password');
  const first=await vault.sync(folder);return {root,folder,vault,remote:first.path};
}
test('sync, comparison and resolution do not recreate an unavailable shared folder',async t=>{
  const {folder,vault}=await setup(t),before=await fs.readFile(vault.path);await fs.rm(folder,{recursive:true});
  for(const operation of [()=>vault.sync(folder),()=>vault.compareSync(folder),()=>vault.resolveSync(folder,'local')]){
    await assert.rejects(operation(),/unavailable/);await assert.rejects(fs.access(folder),{code:'ENOENT'});assert.deepEqual(await fs.readFile(vault.path),before);
  }
});
for(const stage of ['lock','history','write','cleanup'])test(`folder disappears during ${stage}: preserve local bytes and never recreate the shared root`,async t=>{
  const {folder,vault,remote}=await setup(t),offline=folder+'-offline';
  const data=await vault.read();data.settings.fontSize=18;await vault.save(data);const localBefore=await fs.readFile(vault.path),remoteBefore=await fs.readFile(remote);
  const method=stage==='write'?'open':stage==='cleanup'?'rmdir':'mkdir',original=fs[method];let moved=false;
  const stub=t.mock.method(fs,method,async function(file,...args){
    const match=stage==='lock'?file===remote+'.lock':stage==='history'?file===path.join(folder,path.basename(remote,'.harbor-vault')+'.history'):stage==='write'?typeof file==='string'&&file.startsWith(remote+'.')&&file.endsWith('.tmp'):file===remote+'.lock';
    if(!moved&&match){moved=true;await fs.rename(folder,offline)}
    return original.call(this,file,...args);
  });
  try{await assert.rejects(vault.sync(folder),/unavailable/)}finally{stub.mock.restore()}
  assert(moved,'The requested disconnect was injected');await assert.rejects(fs.access(folder),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(vault.path),localBefore);
  assert.deepEqual(await fs.readFile(path.join(offline,path.basename(remote))),stage==='cleanup'?localBefore:remoteBefore);
});
test('lock cleanup cannot replace the original authentication failure',async t=>{
  const {folder,vault,remote}=await setup(t),envelope=JSON.parse(await fs.readFile(remote));envelope.revision++;await fs.writeFile(remote,JSON.stringify(envelope));
  const original=fs.rmdir;const stub=t.mock.method(fs,'rmdir',async function(file,...args){if(file===remote+'.lock')throw Object.assign(new Error('Synthetic cleanup failure'),{code:'EACCES'});return original.call(this,file,...args)});
  try{await assert.rejects(vault.sync(folder),/cannot be authenticated/)}finally{stub.mock.restore()}
});
