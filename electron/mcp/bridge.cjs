#!/usr/bin/env node
'use strict';
// Standalone Node bridge, also copied outside app.asar for installed clients.
const fs=require('node:fs/promises'),tls=require('node:tls'),path=require('node:path');
async function bridge(file){
 if(!file||!path.isAbsolute(file))throw new Error('Provide an absolute Harbor client credential file with --credential.');
 const handle=await fs.open(file,require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);
 let config;try{const stat=await handle.stat();if(!stat.isFile()||stat.size>8192||(process.platform!=='win32'&&(stat.mode&0o077||stat.uid!==process.getuid())))throw new Error('Credential file must be private to this user.');config=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
 if(!/^[a-f0-9-]{36}$/.test(config.clientId)||!/^[a-f0-9]{64}$/.test(config.token)||typeof config.endpoint!=='string')throw new Error('Invalid Harbor credential file.');
 if(process.platform==='win32'?!/^\\\\\.\\pipe\\harbor-mcp-[a-f0-9]{24}$/.test(config.endpoint):(!path.isAbsolute(config.endpoint)||path.basename(config.endpoint)!=='mcp.sock'))throw new Error('Only local Harbor endpoints are allowed.');
 if(typeof config.serverCertificate!=='string'||!config.serverCertificate.includes('BEGIN CERTIFICATE'))throw new Error('Re-pair this client in Harbor.');
 const socket=tls.connect({path:config.endpoint,ca:config.serverCertificate,servername:'harbor.local',rejectUnauthorized:true,minVersion:'TLSv1.3'});socket.setTimeout(5000);
 await new Promise((resolve,reject)=>{socket.once('secureConnect',resolve);socket.once('error',reject);socket.once('timeout',()=>{socket.destroy();reject(new Error('Harbor is unavailable.'))});});socket.setTimeout(0);
 socket.on('error',()=>{process.stderr.write('Harbor connection closed.\n');process.exitCode=1;});
 socket.write(JSON.stringify({clientId:config.clientId,token:config.token})+'\n');config=null;
 let lineBytes=0;
 process.stdin.on('data',chunk=>{for(const b of chunk){lineBytes=b===10?0:lineBytes+1;if(lineBytes>262144){socket.destroy();process.stdin.pause();return;}}if(!socket.write(chunk))process.stdin.pause();});
 socket.on('drain',()=>process.stdin.resume());socket.on('data',chunk=>{if(!process.stdout.write(chunk))socket.pause();});process.stdout.on('drain',()=>socket.resume());
 socket.on('close',()=>{process.stdin.pause();process.stdin.destroy();});process.stdin.on('end',()=>socket.end());
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>socket.destroy());
}
if(require.main===module)bridge(process.argv[2]==='--credential'?process.argv[3]:null).catch(()=>{process.stderr.write('Cannot connect to Harbor. Check the credential file, running app, vault and MCP permissions.\n');process.exitCode=1;});
module.exports={bridge};
