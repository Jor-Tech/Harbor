'use strict';
const {Server} = require('ssh2');
const {generateKeyPairSync} = require('node:crypto');
const hostKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
async function createTerminalServer({otp=false}={}) {
 const clients=new Set(),shells=new Set(),received=[],sizes=[];
 const state={otp,reject:false,connections:0};
 const server=new Server({hostKeys:[hostKey]},client=>{
  state.connections++;clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
  client.on('authentication',ctx=>{
   if(state.reject){ctx.reject();return;}
   if(ctx.method==='password'&&ctx.password==='test-password'){
    if(state.otp)ctx.reject(['keyboard-interactive'],true);else ctx.accept();
   }else if(ctx.method==='keyboard-interactive'&&state.otp){ctx.prompt([{prompt:'Verification code',echo:false}],answers=>{if(!(answers instanceof Error)&&answers[0]==='123456')ctx.accept();else ctx.reject()});}
   else ctx.reject(['password']);
  });
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();session.on('pty',a=>a());session.on('window-change',(a,_r,info)=>{sizes.push(info);a?.()});
   session.on('shell',a=>{const stream=a();shells.add(stream);stream.on('error',()=>{});stream.on('close',()=>shells.delete(stream));stream.write('TERMINAL_READY\r\n');stream.on('data',d=>{received.push(d.toString());stream.write(d)})});
  }));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {clients,shells,received,sizes,state,host:{label:'Terminal test',address:'127.0.0.1',username:'test',port:server.address().port},credential:{password:'test-password'},
  drop(){for(const c of clients)c._sock.destroy()},
  exit(){for(const s of shells){s.exit(0);s.end()}},
  async close(){for(const c of clients)c.end();await new Promise(r=>server.close(r))}
 };
}
module.exports={createTerminalServer};
