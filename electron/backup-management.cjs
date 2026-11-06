'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const LIMIT = 200;
const changed = () => new Error('Backup files or their location changed. Refresh the list and select again.');
const identity = s => `${s.dev}:${s.ino}`;

// Operates only on backend-enumerated copies, never renderer-supplied paths.
class BackupManagement {
  constructor(vault, helpers) { this.vault=vault; this.h=helpers; this.snapshots=new Map(); }
  clear() { this.snapshots.clear(); }
  async directory(folder, optional=false) {
    let stat;
    try { stat=await fs.lstat(folder,{bigint:true}); } catch(e) { if(optional&&e.code==='ENOENT')return null; if(['ENOENT','ENOTDIR'].includes(e.code))throw new Error('This backup location is unavailable. Reconnect it, then refresh the list.'); throw e; }
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Backup locations must be available local directories, not symbolic links.');
    return {path:folder,real:await fs.realpath(folder),identity:identity(stat)};
  }
  async enumerate(scope, folder) {
    const v=this.vault, roots=[], entries=[];
    if(scope==='local') {
      roots.push(await this.directory(path.dirname(v.path)));
      const backups=await this.directory(v.path+'.backups',true); if(backups)roots.push(backups);
      entries.push(...(await v._backupFiles()).map(e=>({...e,source:e.legacy?'legacy':'local'})));
    } else if(scope==='shared') {
      if(typeof folder!=='string'||!path.isAbsolute(folder))throw new Error('Choose an available encrypted sync folder first.');
      roots.push(await this.directory(folder));
      const vaultId=v._envelope.id, history=path.join(folder,`${vaultId}.history`);
      const historyRoot=await this.directory(history,true); if(historyRoot)roots.push(historyRoot);
      if(historyRoot)for(const name of await fs.readdir(history)) {
        if(/^[0-9a-f]{64}\.harbor-vault$/.test(name))entries.push({id:`history:${name}`,file:path.join(history,name),source:'history',reason:'history'});
      }
      const prefix=`${vaultId}.conflict-`;
      for(const name of await fs.readdir(folder)) {
        const suffix=name.startsWith(prefix)?name.slice(prefix.length):'';
        const match=/^(\d{13})-[0-9a-f-]{36}\.harbor-vault$/.exec(suffix);
        if(match)entries.push({id:`conflict:${name}`,file:path.join(folder,name),createdAt:Number(match[1]),source:'conflict',reason:'conflict'});
      }
    } else throw new Error('Choose local backups or shared sync history.');
    const protectedFiles=[v.path];
    if(scope==='shared')protectedFiles.push(path.join(folder,`${v._envelope.id}.harbor-vault`));
    const protectedIdentities=new Set();
    for(const file of protectedFiles)try{protectedIdentities.add(identity(await fs.stat(file,{bigint:true})))}catch(e){if(e.code!=='ENOENT')throw e}
    const files=[];
    for(const entry of entries) {
      try {
        const stat=await fs.lstat(entry.file,{bigint:true});
        if(!stat.isFile()||stat.isSymbolicLink()||protectedFiles.includes(entry.file)||protectedIdentities.has(identity(stat)))continue;
        files.push({...entry,size:Number(stat.size),createdAt:entry.createdAt??Number(stat.mtimeMs),dateSource:entry.createdAt?'filename':'modified',identity:identity(stat)});
      } catch(e) { if(e.code!=='ENOENT')throw e; }
    }
    files.sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));
    return {roots,files};
  }
  list(scope, folder) {
    const v=this.vault,epoch=v._epoch;
    return v._serial(async()=>{
      v._unlocked();v._check(epoch);this.snapshots.delete(scope);
      const {roots,files}=await this.enumerate(scope,folder), rows=[],records=new Map();
      const retention=scope==='local'?await v.retention.info():null;
      for(const entry of files.slice(0,LIMIT)) {
        let protection='unknown',hash=null,problem=null;
        try {
          const bytes=await this.h.readFile(entry.file);hash=this.h.digest(bytes);
          try { const e=this.h.parseEnvelope(bytes);protection=e.version===2?'enhanced':'earlier'; }
          catch { problem='Unrecognized or damaged vault format'; }
        } catch(e) { if(e.code==='ENOENT')continue;problem='File cannot be read safely'; }
        records.set(entry.id,{...entry,hash});
        rows.push({id:entry.id,name:path.basename(entry.file),location:entry.file,source:entry.source,reason:entry.reason,createdAt:entry.createdAt,dateSource:entry.dateSource,size:entry.size,protection,verified:false,problem,kept:retention?(retention.error?null:retention.kept.includes(entry.id)):false,canDelete:hash!==null&&!retention?.error&&!retention?.kept.includes(entry.id),canPreview:hash!==null&&protection!=='unknown'});
        v._check(epoch);
      }
      v._check(epoch);const token=randomUUID();
      this.snapshots.set(scope,{token,folder,roots,records,epoch,vaultId:v._envelope.id,expires:Date.now()+5*60_000,retentionToken:retention?.token});
      return {token,scope,rows,retention,locations:roots.map(r=>r.path),truncated:files.length>LIMIT,limit:LIMIT};
    });
  }
  snapshot(scope,folder,token) {
    const v=this.vault,s=this.snapshots.get(scope);v._unlocked();
    if(!s||s.token!==token||s.folder!==folder||s.epoch!==v._epoch||s.vaultId!==v._envelope.id||s.expires<Date.now())throw new Error('Backup list expired. Refresh the list and select again.');
    return s;
  }
  async validate(s, ids, scope, folder) {
    if(!Array.isArray(ids)||!ids.length||ids.length>LIMIT||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!s.records.has(id)))throw new Error('Select backups from the current list.');
    const current=await this.enumerate(scope,folder);
    for(const root of s.roots){const now=current.roots.find(r=>r.path===root.path);if(!now||now.real!==root.real||now.identity!==root.identity)throw changed()}
    const selected=[];
    for(const id of ids) {
      const expected=s.records.get(id),now=current.files.find(e=>e.id===id);
      if(!expected.hash||!now||now.file!==expected.file||now.identity!==expected.identity)throw changed();
      const bytes=await this.h.readFile(now.file);
      if(this.h.digest(bytes)!==expected.hash)throw changed();
      selected.push({...now,hash:expected.hash});
    }
    this.vault._check(s.epoch);return selected;
  }
  preview(scope,folder,token,id,password) {
    const v=this.vault,epoch=v._epoch;
    return v._serial(async()=>{
      v._check(epoch);const s=this.snapshot(scope,folder,token);
      const [entry]=await this.validate(s,[id],scope,folder);
      const bytes=await this.h.readFile(entry.file);if(this.h.digest(bytes)!==entry.hash)throw changed();
      const e=this.h.parseEnvelope(bytes);const key=await this.h.derive(password,e.salt,this.h.encryptionProfile(e));
      try {
        const data=this.h.decrypt(e,key);await this.validate(s,[id],scope,folder);v._check(epoch);
        return {id,verified:true,protection:e.version===2?'enhanced':'earlier',revision:e.revision,counts:Object.fromEntries(this.h.collections.map(name=>[name,data[name].length])),knownHosts:Object.keys(data.knownHosts).length};
      } finally {key.fill(0)}
    });
  }
  setKeep(folder,token,id,keep) {
    const v=this.vault,epoch=v._epoch;
    return v._serial(()=>this.h.withFileLock(v.path,async()=>{
      v._check(epoch);const s=this.snapshot('local',folder,token);
      await this.validate(s,[id],'local',folder);
      return v.retention.setKept(id,keep,s.retentionToken,epoch);
    }));
  }
  async assertDeletable(scope,ids) {
    if(scope!=='local')return;
    const state=await this.vault.retention.read();
    if(state.error)throw new Error(state.error);
    if(ids.some(id=>state.kept.includes(id)))throw new Error('Remove the Keep mark before deleting a protected backup.');
  }
  delete(scope,folder,token,ids,confirm) {
    const v=this.vault,epoch=v._epoch;
    if(confirm!==true)throw new Error('Confirm deletion of the selected backups first.');
    return v._serial(()=>this.h.withFileLock(v.path,async()=>{
      v._check(epoch);const s=this.snapshot(scope,folder,token);
      const action=async()=>{
        // Validate every selection before deleting any. Recheck each immediately
        // before unlink too: a sync provider need not honor advisory locks.
        const selected=await this.validate(s,ids,scope,folder),deleted=[];
        await this.assertDeletable(scope,ids);
        this.snapshots.delete(scope);v._recoveryPreview=null;
        for(const entry of selected) {
          try {
            await this.validate(s,[entry.id],scope,folder);await this.assertDeletable(scope,[entry.id]);v._check(epoch);
            await fs.unlink(entry.file);deleted.push(entry.id);
          } catch(e) {
            return {deleted,remaining:ids.filter(id=>!deleted.includes(id)),error:e.message};
          }
        }
        return {deleted,remaining:[],error:null};
      };
      return scope==='shared'?this.h.withSharedLock(path.join(folder,`${s.vaultId}.harbor-vault`),action):action();
    }));
  }
}
module.exports={BackupManagement};
