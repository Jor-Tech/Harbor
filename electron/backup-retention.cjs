'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const DEFAULT_POLICY=Object.freeze({maxCount:10,maxAgeDays:0});
const MINIMUM=3;
const validId=id=>typeof id==='string'&&(/^(local:\d{13}-[0-9a-f-]{36}-(save|password|upgrade|import|sync|resolve|manual|recovery)\.hbr|legacy:\d{13}-[0-9a-f-]{36})$/).test(id);
const identity=s=>`${s.dev}:${s.ino}`;
function policy(value){
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='maxAgeDays,maxCount'||![5,10,20,50].includes(value.maxCount)||![0,30,90].includes(value.maxAgeDays))throw new Error('Choose a supported backup count and age limit.');
 return {maxCount:value.maxCount,maxAgeDays:value.maxAgeDays};
}
class BackupRetention {
 constructor(vault,helpers){this.vault=vault;this.h=helpers;this.path=vault.path+'.retention.json';this.lastResult=null;}
 async read(){
  try{
   let bytes;try{bytes=await this.h.readFile(this.path)}catch(e){if(e.code==='ENOENT')return {policy:{...DEFAULT_POLICY},kept:[],token:'missing',configured:false,error:null};throw e}
   if(bytes.length>1024*1024)throw new Error('Oversized retention settings');
   const data=JSON.parse(bytes);
   if(!data||Object.keys(data).sort().join(',')!=='kept,policy,version'||data.version!==1||!Array.isArray(data.kept)||data.kept.length>10000||data.kept.some(id=>!validId(id))||new Set(data.kept).size!==data.kept.length)throw new Error('Invalid retention settings');
   return {policy:policy(data.policy),kept:data.kept,token:this.h.digest(bytes),configured:true,error:null};
  }catch{return {policy:{...DEFAULT_POLICY},kept:[],token:null,configured:true,error:'Automatic cleanup is paused because local retention settings cannot be read safely. Keep markers are unavailable; existing copies have been left in place.'}}
 }
 async info(){const state=await this.read();return {...state,minimum:MINIMUM,lastResult:this.lastResult};}
 async write(state,expected,epoch){
  const v=this.vault,current=await this.read();v._check(epoch);
  if(current.error||current.token!==expected)throw new Error('Retention settings changed or are unreadable. Refresh before making changes.');
  await this.h.atomicWrite(this.path,Buffer.from(JSON.stringify({version:1,policy:policy(state.policy),kept:state.kept})));v._check(epoch);
  v.backupManagement.clear();return this.info();
 }
 setPolicy(value,token,confirm){
  const next=policy(value),v=this.vault,epoch=v._epoch;
  if(confirm!==true)throw new Error('Confirm automatic backup cleanup before saving.');
  return v._serial(()=>this.h.withFileLock(v.path,async()=>{v._unlocked();v._check(epoch);const state=await this.read();return this.write({...state,policy:next},token,epoch)}));
 }
 // Caller holds the vault file lock; changing a Keep flag never deletes a file.
 async setKept(id,keep,token,epoch){
  if(!validId(id)||typeof keep!=='boolean')throw new Error('Choose a local backup and a Keep setting.');
  const state=await this.read(),kept=new Set(state.kept);if(keep)kept.add(id);else kept.delete(id);
  if(kept.size>10000)throw new Error('Too many Keep markers. Remove unused markers before adding more.');
  return this.write({...state,kept:[...kept]},token,epoch);
 }
 async prune(protectedIds=[],configuredOnly=false){
  const v=this.vault,epoch=v._epoch,deleted=[];
  const finish=(extra={})=>(this.lastResult={at:Date.now(),deleted:deleted.length,error:null,...extra});
  try{
   const state=await this.read();v._check(epoch);
   if(state.error)return finish({error:state.error});
   if(configuredOnly&&!state.configured)return finish({skipped:'Default retention runs when a new backup is created.'});
   if(!v._key||!v._envelope)return finish({skipped:'Cleanup waits until the vault is unlocked.'});
   const directory=await v._backupDirectory();if(!directory)return finish();
   // NTFS file IDs can exceed Number's exact integer range. Keep identity exact.
   const root=identity(await fs.lstat(directory,{bigint:true})),active=identity(await fs.stat(v.path,{bigint:true}));
   const entries=(await v._backupFiles()).filter(e=>!e.legacy&&!state.kept.includes(e.id)),copies=[],safety=[];
   for(const entry of entries){
    v._check(epoch);
    try{
     const stat=await fs.lstat(entry.file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||identity(stat)===active)continue;
     const bytes=await this.h.readFile(entry.file),envelope=this.h.parseEnvelope(bytes);
     if(envelope.id!==v._envelope.id)continue;
     const copy={...entry,hash:this.h.digest(bytes),identity:identity(stat)};copies.push(copy);
     // Authenticate the safety copies while streaming files; do not retain
     // every encrypted payload in memory for a large backup history.
     if(safety.length<MINIMUM)try{this.h.decrypt(envelope,v._key);safety.push(copy)}catch{}
     v._check(epoch);
    }catch(e){v._check(epoch);/* Unreadable, unrecognized and other-vault copies are not cleanup candidates. */}
   }
   // A filename/header alone does not prove that a safety copy is usable.
   if(safety.length<MINIMUM)return finish({skipped:'Cleanup waits for three recent backups that can be verified with the current vault key.'});
   const keep=new Set([...protectedIds,...safety.map(e=>e.id)]);
   const cutoff=state.policy.maxAgeDays?Date.now()-state.policy.maxAgeDays*86400000:0;
   const targets=copies.filter((e,index)=>!keep.has(e.id)&&(index>=state.policy.maxCount||(cutoff&&e.createdAt<cutoff)));
   const unchanged=async copy=>{
    const stat=await fs.lstat(copy.file,{bigint:true});
    if(!stat.isFile()||stat.isSymbolicLink()||identity(stat)!==copy.identity||this.h.digest(await this.h.readFile(copy.file))!==copy.hash)throw new Error('Backup files changed during cleanup. Remaining copies were preserved.');
   };
   for(const copy of targets){
    const latest=await this.read();v._check(epoch);
    if(latest.error||latest.token!==state.token)throw new Error('Retention settings changed during cleanup. Remaining copies were preserved.');
    const currentDirectory=await v._backupDirectory();if(currentDirectory!==directory||identity(await fs.lstat(directory,{bigint:true}))!==root)throw new Error('The backup folder changed during cleanup. Remaining copies were preserved.');
    for(const retained of safety)await unchanged(retained);
    await unchanged(copy);v._check(epoch);await fs.unlink(copy.file);deleted.push(copy.id);
   }
   if(deleted.length){v.backupManagement.clear();v._recoveryPreview=null;}
   return finish();
  }catch(e){if(deleted.length){v.backupManagement.clear();v._recoveryPreview=null;}return finish({error:e.message});}
 }
 cleanup(configuredOnly=true){
  const v=this.vault,epoch=v._epoch;
  return v._serial(()=>this.h.withFileLock(v.path,async()=>{v._unlocked();v._check(epoch);await v._unchanged();return this.prune([],configuredOnly)}));
 }
}
module.exports={BackupRetention,DEFAULT_POLICY,MINIMUM};
