#!/usr/bin/env node
'use strict';
const path=require('node:path'),{Vault}=require('../vault.cjs'),{resolveHost,resolveRoute}=require('../host-model.cjs'),{McpAccess}=require('./access.cjs'),{McpSsh}=require('./ssh.cjs'),{acquireRuntime}=require('../runtime-lock.cjs');
function resolveConnection(data,id){
 const raw=data.hosts.find(h=>h.id===id);if(!raw)throw new Error('Unknown host.');
 const credential=host=>{const base={username:host.username,password:host.password},provider=host.agentProvider||(host.useAgent?'system':'none');if(provider!=='none')return {...base,useAgent:true,agentProvider:provider,agentSocket:host.agentSocket,agentFingerprint:host.agentFingerprint};const key=data.keys.find(k=>k.id===host.keyId);if(host.keyId&&!key)throw new Error('Unknown key.');return key?{...base,privateKey:key.privateKey,passphrase:key.passphrase}:base;};
 const host=resolveHost(data,raw);return {host,credential:credential(host),route:resolveRoute(data,host).map(host=>({host,credential:credential(host)}))};
}
async function startHeadless(dir,prompt){
 if(!path.isAbsolute(dir))throw new Error('Use an absolute data directory.');
 const release=acquireRuntime(dir),vault=new Vault(path.join(dir,'vault.hbr'));let access,timer;
 try{
  access=new McpAccess({dir,readVault:()=>vault.read(),bridgePath:path.join(__dirname,'bridge.cjs')});await access.load();await access.loadAudit();
  if(access.error||!access.state.enabled)throw new Error('Enable and configure MCP in Harbor first, then quit Harbor.');
  const status=await vault.status();if(!status.exists)throw new Error('Create a vault in Harbor first.');
  let password=await prompt();await vault.unlock(password);password=null;access.headless=true;
  access.ssh=new McpSsh({resolve:async id=>resolveConnection(await vault.read(),id),verifyHost:async info=>{const data=await vault.read(),prior=data.knownHosts[`${info.hostname}:${info.port}`];return (typeof prior==='string'?prior:prior?.fingerprint)===info.fingerprint;},requestAuth:async()=>{throw new Error('Interactive authentication is unavailable in headless mode.');}});
  access.ssh.onClosed=id=>{access.sessions.delete(id);access.changed()};
  await access.resume();const data=await vault.read();let closed=false;
  const close=async()=>{if(closed)return;closed=true;clearTimeout(timer);process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);await access.close();vault.lock();release();};
  const shutdown=()=>{void close()};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  timer=setTimeout(shutdown,Math.max(1,Math.min(60,Number(data.settings.autoLockMinutes)||15))*60000);
  return {access,vault,close};
 }catch(error){clearTimeout(timer);await access?.close();vault.lock();release();throw error;}
}
async function ttyPassword(){
 if(!process.stdin.isTTY||!process.stdin.setRawMode)throw new Error('Start in a local interactive terminal to unlock. Piped passwords are refused.');
 process.stderr.write('Unlock vault and start preapproved local MCP automation (password hidden): ');
 process.stdin.setRawMode(true);process.stdin.resume();let password='';const decoder=new (require('node:string_decoder').StringDecoder)('utf8');
 return new Promise((resolve,reject)=>{const finish=(error)=>{process.stdin.removeListener('data',input);process.stdin.setRawMode(false);process.stdin.pause();process.stderr.write('\n');if(error){password='';reject(error)}else resolve(password);};const input=chunk=>{for(const character of decoder.write(chunk)){if(character==='\r'||character==='\n'){finish();return;}if(character==='\u0003'){finish(new Error('Cancelled.'));return;}if(character==='\u007f'||character==='\b')password=password.slice(0,-1);else if(character>=' '&&password.length<1024)password+=character;}};process.stdin.on('data',input);});
}
if(require.main===module){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--data-dir'||!path.isAbsolute(args[1])){process.stderr.write('Usage: node electron/mcp/headless.cjs --data-dir /absolute/Harbor-data-directory\n');process.exitCode=1;}
 else startHeadless(args[1],ttyPassword).then(()=>process.stderr.write('Harbor headless MCP active. Only explicitly preapproved rules run. Automatic lock stops this process; Ctrl+C quits.\n')).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
}
module.exports={startHeadless,ttyPassword,resolveConnection};
