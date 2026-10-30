'use strict';
const {Server} = require('ssh2');
const {generateKeyPairSync} = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {serveSftp} = require('./sftp-server.cjs');
const hostKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
// ssh2's server Channel.end() also sends CLOSE; use EOF for a TCP half-close.
const link=(a,b)=>{a.on('error',()=>b.destroy());b.on('error',()=>a.destroy());a.on('close',()=>b.destroy());b.on('close',()=>a.destroy());a.pipe(b,{end:false});a.on('end',()=>b.eof());b.pipe(a);};
async function createRoutingServer({username='test',password='route-password',otp,allowRemote=true,hangChannel=false,denyChannel=false,hangRemote=false}={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-route-server-'));
 const clients=new Set(),sockets=new Set(),bindings=new Map(),forwardRequests=[],authAttempts=[],remoteRequests=[];
 const track=s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));return s;};
 const server=new Server({hostKeys:[hostKey]},client=>{
  clients.add(client);client.on('error',()=>{});
  client.on('close',()=>{clients.delete(client);for(const [key,b] of bindings)if(b.client===client){b.server.close();bindings.delete(key);}});
  let passwordAccepted=false;
  client.on('authentication',ctx=>{
   authAttempts.push({method:ctx.method,username:ctx.username});
   if(ctx.username!==username){ctx.reject(['password']);return;}
   if(ctx.method==='password'&&ctx.password===password){
    passwordAccepted=true;if(otp)ctx.reject(['keyboard-interactive'],true);else ctx.accept();
   }else if(passwordAccepted&&otp&&ctx.method==='keyboard-interactive'){
    ctx.prompt([{prompt:'Verification code',echo:false}],answers=>answers[0]===otp?ctx.accept():ctx.reject(['keyboard-interactive']));
   }else ctx.reject(passwordAccepted&&otp?['keyboard-interactive']:['password']);
  });
  client.on('ready',()=>{
   client.on('session',accept=>{
    const s=accept();s.on('pty',a=>a());s.on('window-change',a=>a?.());
    s.on('shell',a=>{const stream=track(a());stream.write('ROUTE_READY\r\n');stream.on('data',d=>stream.write(d));});
    s.on('sftp',a=>serveSftp(a(),root));
   });
   client.on('tcpip',(accept,reject,info)=>{
    forwardRequests.push(info);
    if(hangChannel)return;
    if(denyChannel){reject();return;}
    // Synthetic private names are only reachable through this server.
    const host=info.destIP.endsWith('.internal.test')||info.destIP==='0:0:0:0:0:0:0:1'?'127.0.0.1':info.destIP;
    if(!['127.0.0.1','::1'].includes(host)){reject();return;}
    const socket=track(net.connect(info.destPort,host));
    socket.once('error',()=>reject());socket.once('connect',()=>link(socket,track(accept())));
   });
   client.on('request',(accept,reject,name,info)=>{
    if(name==='cancel-tcpip-forward'){
     const binding=bindings.get(info.bindPort);if(binding){binding.server.close();bindings.delete(info.bindPort);accept?.();}else reject?.();return;
    }
    if(name!=='tcpip-forward'||!allowRemote||info.bindAddr!=='127.0.0.1'){reject?.();return;}
    remoteRequests.push(info);if(hangRemote)return;
    const listener=net.createServer({allowHalfOpen:true},socket=>{
     track(socket);
     client.forwardOut('127.0.0.1',listener.address().port,socket.remoteAddress,socket.remotePort,(error,stream)=>{
      if(error){socket.destroy();return;}link(socket,track(stream));
     });
    });
    listener.once('error',()=>reject?.());
    listener.listen(info.bindPort,info.bindAddr,()=>{
     const port=listener.address().port;bindings.set(port,{server:listener,client});accept?.(port);
    });
   });
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {root,clients,bindings,forwardRequests,authAttempts,remoteRequests,host:{id:'host-'+server.address().port,label:username,address:'127.0.0.1',port:server.address().port,username},credential:{password},
  close:async()=>{for(const s of sockets)s.destroy();for(const b of bindings.values())b.server.close();for(const c of clients)c.end();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}};
}
module.exports={createRoutingServer};
