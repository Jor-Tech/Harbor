'use strict';
const path=require('node:path'),os=require('node:os'),{randomUUID,createHash}=require('node:crypto');
const {ConnectionManager}=require('../connections.cjs'),{LIMITS}=require('./policy.cjs');
const {ActionError}=require('./errors.cjs');
const invoke=(target,method,...args)=>new Promise((resolve,reject)=>target[method](...args,(error,value)=>error?reject(error):resolve(value)));
class McpSsh {
 constructor({resolve,verifyHost,requestAuth}){this.resolve=resolve;this.manager=new ConnectionManager({verifyHost,requestAuth,emit:(event,data)=>{if(event==='terminal:status'&&['closed','error'].includes(data.status))this.onClosed?.(data.id)}});}
 async describe(hostId){const resolved=await this.resolve(hostId);const {host,route=[]}=resolved;
  // Standing permissions bind to public account/route identity, never a hash of secrets.
  const identity=({host,credential={}})=>({address:host.hostname||host.address,port:Number(host.port)||22,username:credential.username||host.username||os.userInfo().username}),target=identity(resolved),via=route.map(identity);
  return {resolved,digest:createHash('sha256').update(JSON.stringify(resolved)).digest('hex'),approvalDigest:createHash('sha256').update(JSON.stringify([target,...via])).digest('hex'),target:{id:hostId,label:host.label,...target,via:via.map(h=>`${h.username}@${h.address}:${h.port}`)}};
 }
 async connect(hostId,expected,check,id){const d=await this.describe(hostId);check();if(d.digest!==expected)throw new Error('Host configuration changed.');await this.manager._open(d.resolved.host,d.resolved.credential,'ssh',d.resolved.route,id);check();return {id};}
 close(id){this.manager.close(id);}
 closeAll(){this.manager.closeAll();}
 async exec(id,command,check){
  const s=this.manager._session(id),stream=await this.manager._request(s,done=>s.client.exec(command,done));check();
  return new Promise((resolve,reject)=>{
   const chunks=[],errors=[];let size=0,exitCode=null,signal=null,done=false;
   const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(error){stream.destroy();reject(error);}else{try{check();resolve({stdout:Buffer.concat(chunks).toString('utf8'),stderr:Buffer.concat(errors).toString('utf8'),exitCode,signal,untrustedContent:true});}catch(e){reject(e)}}};
   const timer=setTimeout(()=>{this.close(id);finish(new Error('Command timed out; connection closed.'));},LIMITS.executionMs);
   const data=(list,chunk)=>{const b=Buffer.from(chunk);size+=b.length;if(size>LIMITS.output){this.close(id);finish(new Error('Output limit exceeded; connection closed.'));}else list.push(b)};
   // Fast servers may emit exit before the awaited exec callback resumes.
   // ssh2 repeats the final status on close, after buffered output is drained.
   stream.on('data',d=>data(chunks,d));stream.stderr.on('data',d=>data(errors,d));stream.on('exit',(code,sig)=>{exitCode=code;signal=sig||null});stream.once('error',()=>finish(new Error('Command failed.')));stream.once('close',(code,sig)=>{if(code!==undefined)exitCode=code;if(sig)signal=sig;finish()});
  });
 }
 async list(id,remote,check){
  const sftp=await this.manager._sftp(id);check();const actual=await invoke(sftp,'realpath',remote);check();const handle=await invoke(sftp,'opendir',actual),entries=[];let truncated=false;
  try{while(entries.length<=200){let batch;try{batch=await invoke(sftp,'readdir',handle)}catch(error){if(error.code===1)break;throw error;}check();if(batch===false)break;for(const row of batch){if(['.','..'].includes(row.filename))continue;if(entries.length===200){truncated=true;break;}entries.push({name:String(row.filename).slice(0,255),isDirectory:row.attrs.isDirectory(),isSymlink:row.attrs.isSymbolicLink(),size:row.attrs.size});}if(truncated)break;}}
  finally{await invoke(sftp,'close',handle).catch(()=>{});}check();return {path:String(actual).slice(0,2048),entries,truncated,untrustedContent:true};
 }
 async read(id,remote,check){
  const sftp=await this.manager._sftp(id);check();const attrs=await invoke(sftp,'stat',remote);check();if(!attrs.isFile()||attrs.size>LIMITS.output)throw new Error('Choose a regular file up to 64 KiB.');
  const chunks=[];let bytes=0;const stream=sftp.createReadStream(remote);
  for await(const chunk of stream){check();bytes+=chunk.length;if(bytes>LIMITS.output){stream.destroy();throw new Error('File too large.');}chunks.push(chunk);}
  check();return {content:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),untrustedContent:true};
 }
 async write(id,remote,content,check){
  if(Buffer.byteLength(content)>LIMITS.output)throw new Error('File content too large.');const sftp=await this.manager._sftp(id);check();
  const temporary=path.posix.join(path.posix.dirname(remote),'.harbor-mcp-'+randomUUID()+'.tmp');
  try{
   const stream=sftp.createWriteStream(temporary,{flags:'wx',mode:0o600});await new Promise((resolve,reject)=>{stream.once('error',reject);stream.once('close',resolve);stream.end(content)});check();
   try{
    if(typeof sftp.ext_openssh_rename!=='function')throw Object.assign(new Error('Unsupported extension'),{code:8});
    await invoke(sftp,'ext_openssh_rename',temporary,remote);
   }catch(error){
    // ssh2 throws synchronously when the extension was not advertised. A server
    // may also answer SSH_FX_OP_UNSUPPORTED. Other failures must not be retried.
    if(error.code!==8&&error.message!=='Server does not support this extended request')throw error;
    check();let exists=true;
    try{await invoke(sftp,'lstat',remote)}catch(statError){if(statError.code!==2)throw statError;exists=false;}
    check();if(exists)throw new ActionError('ATOMIC_REPLACE_UNSUPPORTED');
    // Standard SFTP v3 rename refuses an existing destination, including one
    // created since lstat. Never unlink or truncate the destination as fallback.
    await invoke(sftp,'rename',temporary,remote);
   }
   check();return {written:true};
  }
  finally{await invoke(sftp,'unlink',temporary).catch(()=>{});}
 }
}
module.exports={McpSsh};
