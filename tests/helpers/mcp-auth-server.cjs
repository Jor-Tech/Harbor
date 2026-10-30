'use strict';
const {Server,utils,AgentProtocol}=require('ssh2'),net=require('node:net'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{generateKeyPairSync,randomUUID}=require('node:crypto');
const {generateKeyPair}=require('../../electron/keys.cjs'),{keyInfo}=require('../../electron/ssh-agent.cjs');
async function createMcpAuthServer(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-auth-')),pair=generateKeyPair('ed25519',{passphrase:'fixture-key-passphrase',cipher:'aes256-cbc',rounds:4}),key=utils.parseKey(pair.private,'fixture-key-passphrase'),other=utils.parseKey(generateKeyPair('ed25519').private),clients=new Set(),sockets=new Set(),signed=[];
 const agentPath=process.platform==='win32'?'\\\\.\\pipe\\harbor-auth-'+randomUUID():path.join(dir,'agent.sock');
 const agent=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));const protocol=new AgentProtocol(false);protocol.on('error',()=>socket.destroy());socket.pipe(protocol).pipe(socket);protocol.on('identities',r=>protocol.getIdentitiesReply(r,[other,key]));protocol.on('sign',(r,pub,data,options)=>{if(!pub.getPublicSSH().equals(key.getPublicSSH())){protocol.failureReply(r);return;}signed.push(keyInfo(key).fingerprint);protocol.signReply(r,key.sign(data,options.hash))});});
 await new Promise(r=>agent.listen(agentPath,r));
 const server=new Server({hostKeys:[generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'})]},client=>{clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));let accepted=false;
  client.on('authentication',ctx=>{if(ctx.username!=='test'){ctx.reject(['publickey']);return;}
   if(ctx.method==='publickey'&&ctx.key.data.equals(key.getPublicSSH())){if(!ctx.signature){ctx.accept();return;}if(key.verify(ctx.blob,ctx.signature,ctx.hashAlgo)!==true){ctx.reject();return;}accepted=true;ctx.reject(['keyboard-interactive'],true);return;}
   if(ctx.method==='keyboard-interactive'&&accepted){ctx.prompt([{prompt:'Verification code',echo:false}],answers=>!(answers instanceof Error)&&answers[0]==='654321'?ctx.accept():ctx.reject());return;}ctx.reject(['publickey']);
  });client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('exec',accept=>{const stream=accept();stream.on('error',()=>{});stream.write('MCP_KEY_MFA_OK');stream.exit(0);stream.end()});}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {privateKey:pair.private,agentPath,signed,fingerprint:keyInfo(key).fingerprint,host:{address:'127.0.0.1',port:server.address().port,username:'test'},async close(){for(const c of clients)c.destroy();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>agent.close(r))]);await fs.rm(dir,{recursive:true,force:true})}};
}
module.exports={createMcpAuthServer};
