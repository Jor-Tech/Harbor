'use strict';
const {Server,utils}=require('ssh2'),{generateKeyPairSync,createHash}=require('node:crypto'),{serveSftp}=require('./sftp-server.cjs');
async function createMcpServer(root,{username='test',sftpControl={}}={}){
 const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'}),clients=new Set(),commands=[];
 const server=new Server({hostKeys:[key]},client=>{clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
  client.on('authentication',ctx=>ctx.method==='password'&&ctx.username===username&&ctx.password==='fixture-password'?ctx.accept():ctx.reject(['password']));
  client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('exec',(accept,_reject,info)=>{commands.push(info.command);const stream=accept();stream.on('error',()=>{});
   if(info.command==='fixture-hang'){stream.write('waiting');return;}
   if(info.command==='fixture-big')stream.write('x'.repeat(70000));else {stream.write('HARBOR_MCP_OK');stream.stderr.write('fixture warning');}stream.exit(23);stream.end();
  });session.on('sftp',accept=>serveSftp(accept(),root,sftpControl));}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {fingerprint:'SHA256:'+createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/,''),commands,clients,host:{id:'fixture',label:'MCP fixture',address:'127.0.0.1',port:server.address().port,username,password:'fixture-password'},async close(){for(const c of clients)c.end();await new Promise(resolve=>server.close(resolve));}};
}
module.exports={createMcpServer};
