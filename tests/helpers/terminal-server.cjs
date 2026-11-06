'use strict';
const {Server} = require('ssh2');
const {generateKeyPairSync} = require('node:crypto');
const hostKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
async function createTerminalServer({otp=false,tmux=true}={}) {
 const clients=new Set(),shells=new Set(),received=[],sizes=[];
 const state={otp,reject:false,connections:0,tmux,commands:[],persistent:new Map()};
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
   session.on('exec',(accept,_reject,info)=>{
    const stream=accept();stream.on('error',()=>{});state.commands.push(info.command);
    if(info.command==='command -v tmux >/dev/null 2>&1'){stream.exit(state.tmux?0:127);stream.end();return;}
    const start=info.command.match(/^exec tmux new-session -A -s '(harbor-[a-f0-9-]+)'$/);
    const kill=info.command.match(/^tmux kill-session -t '=(harbor-[a-f0-9-]+)'$/);
    if(start){
     const name=start[1];if(!state.persistent.has(name))state.persistent.set(name,{input:[],streams:new Set()});
     const remote=state.persistent.get(name);remote.streams.add(stream);shells.add(stream);
     stream.on('close',()=>{shells.delete(stream);remote.streams.delete(stream)});
     stream.write('PERSISTENT_READY\r\n');stream.on('data',d=>{remote.input.push(d.toString());received.push(d.toString());stream.write(d)});
    }else if(kill){
     const remote=state.persistent.get(kill[1]);
     if(remote){for(const s of remote.streams){s.exit(0);s.end()}state.persistent.delete(kill[1]);}
     stream.exit(remote?0:1);stream.end();
    }else {stream.exit(127);stream.end();}
   });
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
