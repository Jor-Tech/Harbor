'use strict';
const fs=require('node:fs/promises'),native=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID,createHash}=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const call=(s,m,...args)=>new Promise((res,rej)=>s[m](...args,(e,v)=>e?rej(e):res(v)));
const hash=data=>createHash('sha256').update(data).digest('hex');
const {filename,absolute,remoteAbsolute,transferPaths}=require('./file-paths.cjs');
async function maybeStat(fn){try{return await fn()}catch(e){if(e.code==='ENOENT'||e.code===2)return null;throw e}}
class Files {
 constructor(connections,emit=()=>{}){this.connections=connections;this.emit=emit;this.jobs=new Map();this.queue=Promise.resolve();}
 async listLocal(directory){const folder=await fs.realpath(absolute(directory||os.homedir()));const entries=await fs.readdir(folder,{withFileTypes:true});return {path:folder,parentPath:path.dirname(folder),entries:(await Promise.all(entries.map(async e=>{try{const s=await fs.lstat(path.join(folder,e.name));return {name:e.name,path:path.join(folder,e.name),isDirectory:s.isDirectory(),isSymlink:s.isSymbolicLink(),size:s.size,mode:s.mode&0o777,modified:s.mtime.toISOString()}}catch{return null}}))).filter(Boolean).sort((a,b)=>Number(b.isDirectory)-Number(a.isDirectory)||a.name.localeCompare(b.name))};}
 async rename(id,source,name){filename(name,'posix');source=remoteAbsolute(source);const target=path.posix.join(path.posix.dirname(source),name);const s=await this.connections._sftp(id);if(await maybeStat(()=>call(s,'lstat',target)))throw new Error('A file with that name already exists');await call(s,'rename',source,target);}
 async chmod(id,target,mode){if(typeof mode!=='string'||!/^0?[0-7]{3}$/.test(mode))throw new Error('Enter permissions such as 644 or 755');await call(await this.connections._sftp(id),'chmod',remoteAbsolute(target),parseInt(mode,8));}
 async readText(id,target){const s=await this.connections._sftp(id);target=remoteAbsolute(target);const st=await call(s,'lstat',target);if(!st.isFile()||st.size>1024*1024)throw new Error('The editor supports regular UTF-8 text files up to 1 MiB');const stream=s.createReadStream(target),chunks=[];const closed=new Promise(resolve=>stream.once('close',resolve));stream.on('error',()=>{});let bytes=0;try{for await(const c of stream){bytes+=c.length;if(bytes>1024*1024){stream.destroy();throw new Error('File is too large')}chunks.push(c)}}finally{await closed}const buf=Buffer.concat(chunks);let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buf)}catch{throw new Error('This file is not UTF-8 text')}if(text.includes('\0'))throw new Error('Binary files cannot be edited');return {text,hash:hash(buf),mode:st.mode&0o777};}
 async saveText(id,target,text,expectedHash){if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)throw new Error('Text exceeds the 1 MiB editor limit');const current=await this.readText(id,target);if(current.hash!==expectedHash)throw new Error('The remote file changed. Reload it before saving to avoid overwriting another edit.');const s=await this.connections._sftp(id),temp=target+'.harbor-'+randomUUID()+'.part';try{const stream=s.createWriteStream(temp,{flags:'wx',mode:current.mode});await pipeline(require('node:stream').Readable.from([Buffer.from(text)]),stream);const check=await this.readText(id,target);if(check.hash!==expectedHash)throw new Error('The remote file changed while saving');if(typeof s.ext_openssh_rename!=='function')throw new Error('This server cannot safely replace edited files');await call(s,'ext_openssh_rename',temp,target);return {text,hash:hash(Buffer.from(text)),mode:current.mode}}finally{await call(s,'unlink',temp).catch(()=>{})}}
 list(){return [...this.jobs.values()].map(j=>this.snapshot(j));}
 snapshot(j){return {id:j.id,sessionId:j.sessionId,direction:j.direction,label:j.label,status:j.status,bytes:j.bytes,total:j.total,files:j.files,error:j.error||''};}
 update(j){if(this.jobs.has(j.id))this.emit('transfer:status',this.snapshot(j));}
 cancel(id){const j=this.jobs.get(id);if(j&&!j.controller.signal.aborted&&!['complete','failed','cancelled'].includes(j.status)){j.controller.abort();j.status='cancelling';this.update(j)}}
 cancelSession(id){for(const j of this.jobs.values())if(j.sessionId===id)this.cancel(j.id)}
 cancelAll(){for(const j of this.jobs.values())j.controller.abort();this.jobs.clear();}
 start({id,direction,sources,destination,overwrite=false}){
  if(!['upload','download'].includes(direction)||!Array.isArray(sources)||!sources.length||sources.length>1000)throw new Error('Invalid transfer request');
  this.connections._session(id);const paths=transferPaths(direction);sources=sources.map(p=>absolute(p,paths.source));destination=absolute(destination,paths.target);
  if(this.jobs.size>=100){for(const [key,j] of this.jobs)if(['complete','failed','cancelled'].includes(j.status))this.jobs.delete(key);if(this.jobs.size>=100)throw new Error('Too many queued transfers')}
  const j={id:randomUUID(),sessionId:id,direction,label:sources.map(p=>paths.source.basename(p)).join(', '),status:'queued',bytes:0,total:0,files:0,controller:new AbortController()};this.jobs.set(j.id,j);this.update(j);
  this.queue=this.queue.catch(()=>{}).then(async()=>{try{j.controller.signal.throwIfAborted();j.status='scanning';this.update(j);await this.transfer(j,sources,destination,overwrite);j.status='complete'}catch(e){j.status=j.controller.signal.aborted?'cancelled':'failed';j.error=j.status==='failed'?e.message:''}finally{this.update(j)}});
  return this.snapshot(j);
 }
 async transfer(j,sources,destination,overwrite){
  const s=await this.connections._sftp(j.sessionId),signal=j.controller.signal,upload=j.direction==='upload',plan=[],paths=transferPaths(j.direction);
  const check=()=>{signal.throwIfAborted();this.connections._session(j.sessionId)};
  async function scan(source,target,depth=0){check();if(depth>32||plan.length>=20000)throw new Error('Directory transfer is too large or too deep');const st=upload?await fs.lstat(source):await call(s,'lstat',source);if(st.isSymbolicLink())throw new Error('Symbolic links are not followed during transfers: '+source);if(!st.isDirectory()&&!st.isFile())throw new Error('Only regular files and directories can be transferred');plan.push({source,target,directory:st.isDirectory(),size:st.size});if(st.isDirectory()){const entries=upload?await fs.readdir(source):(await call(s,'readdir',source)).map(e=>e.filename).filter(n=>n!=='.'&&n!=='..');for(const entry of entries){filename(entry);await scan(paths.source.join(source,entry),paths.target.join(target,entry),depth+1)}}else j.total+=st.size;}
  for(const source of sources)await scan(source,paths.target.join(destination,filename(paths.source.basename(source))));
  const destStat=upload?await call(s,'lstat',destination):await fs.lstat(destination);if(!destStat.isDirectory()||destStat.isSymbolicLink())throw new Error('Destination must be a real directory');
  // Preflight every destination before writing any file; existing symlinks are refused.
  for(const entry of plan){check();const st=await maybeStat(()=>upload?call(s,'lstat',entry.target):fs.lstat(entry.target));if(st&&(st.isSymbolicLink()||st.isDirectory()!==entry.directory))throw new Error('Destination type conflicts: '+entry.target);if(st&&!entry.directory&&!overwrite)throw new Error('File already exists; enable replacement to overwrite: '+entry.target);entry.exists=!!st;}
  j.status='running';this.update(j);let lastUpdate=0;
  for(const entry of plan){check();if(entry.directory){if(!entry.exists){if(upload)await call(s,'mkdir',entry.target,{mode:0o700});else await fs.mkdir(entry.target,{mode:0o700})}continue;}
   const temp=paths.target.join(paths.target.dirname(entry.target),'.'+paths.target.basename(entry.target)+'.harbor-'+randomUUID()+'.part');
   try{
    const input=upload?native.createReadStream(entry.source,{flags:native.constants.O_RDONLY|native.constants.O_NOFOLLOW}):s.createReadStream(entry.source);
    const output=upload?s.createWriteStream(temp,{flags:'wx',mode:0o600}):native.createWriteStream(temp,{flags:'wx',mode:0o600});
    input.on('data',chunk=>{j.bytes+=chunk.length;if(Date.now()-lastUpdate>100){lastUpdate=Date.now();this.update(j)}});
    await pipeline(input,output,{signal});check();
    if(upload){if(!overwrite&&await maybeStat(()=>call(s,'lstat',entry.target)))throw new Error('Destination appeared during transfer');await call(s,overwrite?'ext_openssh_rename':'rename',temp,entry.target)}
    else if(overwrite)await fs.rename(temp,entry.target);else {await fs.link(temp,entry.target);await fs.unlink(temp)}
    j.files++;this.update(j);
   }finally{if(upload)await call(s,'unlink',temp).catch(()=>{});else await fs.rm(temp,{force:true}).catch(()=>{})}
  }
 }
}
module.exports={Files,filename,absolute};
