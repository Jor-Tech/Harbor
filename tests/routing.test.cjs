'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const {once}=require('node:events');
const {ConnectionManager}=require('../electron/connections.cjs');
const {resolveRoute}=require('../electron/host-model.cjs');
const {forwardConfig}=require('../electron/forwarding.cjs');
const {createRoutingServer}=require('./helpers/routing-server.cjs');

async function eventually(fn){for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Expected state did not arrive');}
async function setup(t,options={}){const server=await createRoutingServer(options);t.after(()=>server.close());return server;}
function manager(t,options={}){const m=new ConnectionManager({verifyHost:async()=>true,...options});t.after(()=>m.closeAll());return m;}
async function echo(t){const sockets=new Set(),server=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));s.pipe(s);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});return server.address().port;}
async function socket(t,port){const s=net.connect(port,'127.0.0.1');s.on('error',()=>{});t.after(()=>s.destroy());await once(s,'connect');return s;}
async function exchange(s,payload){const answer=once(s,'data');s.write(payload);return (await answer)[0];}
const hop=s=>({host:s.host,credential:s.credential});

test('routes resolve outermost first with inherited credentials and reject cycles, missing hosts and excessive depth',()=>{
 const data={groups:[{id:'g',label:'Ops',defaults:{username:'inherited'}}],hosts:[{id:'a',groupId:'g',inherit:{username:true}},{id:'b',jumpHostId:'a'},{id:'c',jumpHostId:'b'}]};
 const route=resolveRoute(data,data.hosts[2]);assert.deepEqual(route.map(h=>h.id),['a','b']);assert.equal(route[0].username,'inherited');
 data.hosts[0].jumpHostId='c';assert.throws(()=>resolveRoute(data,data.hosts[2]),/cycle/);
 data.hosts[0].jumpHostId='missing';assert.throws(()=>resolveRoute(data,data.hosts[2]),/not found/);
 const many={groups:[],hosts:Array.from({length:10},(_,i)=>({id:String(i),jumpHostId:i?String(i-1):''}))};
 assert.throws(()=>resolveRoute(many,many.hosts[9]),/eight/);
 assert.deepEqual(resolveRoute({groups:[],hosts:[]},{address:'example.test'}),[]);
});

test('multiple jump hosts authenticate separately; terminal and SFTP reach the private target', {timeout:15000}, async t=>{
 const a=await setup(t,{username:'outer',password:'outer-password',otp:'111111'}),b=await setup(t,{username:'inner',password:'inner-password',otp:'222222'}),target=await setup(t,{username:'target',password:'target-password',otp:'333333'});
 const prompts=[],verified=[],events=[];
 const m=manager(t,{verifyHost:async h=>{verified.push(h);return true;},requestAuth:async p=>{prompts.push(p);return [{outer:'111111',inner:'222222',target:'333333'}[p.username]];},emit:(event,data)=>events.push({event,...data})});
 await fs.writeFile(path.join(target.root,'note.txt'),'private data');
 const session=await m.connect({...target.host,address:'target.internal.test'},target.credential,[hop(a),{...hop(b),host:{...b.host,address:'inner.internal.test'}}]);
 assert.deepEqual(prompts.map(p=>p.username),['outer','inner','target']);assert.deepEqual(verified.map(h=>h.hostname),['127.0.0.1','inner.internal.test','target.internal.test']);
 assert.equal(new Set(prompts.map(p=>p.connectionId)).size,1);
 m.write(session.id,'via two jumps');await eventually(()=>events.some(e=>e.data?.includes('via two jumps')));
 assert.equal((await m.listFiles(session.id,'/')).entries[0].name,'note.txt');
 assert.equal(m.sessions.size,1);assert.equal(a.forwardRequests[0].destIP,'inner.internal.test');assert.equal(b.forwardRequests[0].destIP,'target.internal.test');
 m.close(session.id);await eventually(()=>!a.clients.size&&!b.clients.size&&!target.clients.size);
});

test('rejecting a target host key closes the whole route before target authentication', {timeout:10000},async t=>{
 const jump=await setup(t),target=await setup(t);
 const m=manager(t,{verifyHost:async h=>h.port!==target.host.port});
 await assert.rejects(m.connect(target.host,target.credential,[hop(jump)]),/verification failed/);
 await eventually(()=>!jump.clients.size&&!target.clients.size);assert.equal(m.sessions.size,0);assert.equal(target.authAttempts.length,0);
});

test('locking during target MFA aborts its prompt and closes every hop', {timeout:10000},async t=>{
 const jump=await setup(t),target=await setup(t,{otp:'123456'});let signal;
 const m=manager(t,{requestAuth:(_p,options)=>new Promise((resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(new Error('Authentication cancelled')),{once:true});})});
 const attempt=m.connect(target.host,target.credential,[hop(jump)]);const rejected=assert.rejects(attempt,/cancelled|closed/);
 await eventually(()=>signal);m.closeAll();await rejected;assert(signal.aborted);await eventually(()=>!jump.clients.size&&!target.clients.size);
});

test('a pending jump channel is cancelled on lock; denied channels leave no sessions', {timeout:10000},async t=>{
 for(const options of [{hangChannel:true},{denyChannel:true}]){
  const jump=await setup(t,options),m=manager(t);
  const attempt=m.connect({address:'target.internal.test',port:22},{},[hop(jump)]),rejected=assert.rejects(attempt);
  await eventually(()=>jump.forwardRequests.length);if(options.hangChannel)m.closeAll();await rejected;assert.equal(m.sessions.size,0);
 }
});

test('legacy local forwarding rules remain compatible and invalid types/ports fail early',()=>{
 assert.deepEqual(forwardConfig({localPort:8080,remoteHost:'db',remotePort:5432}),{type:'local',listenPort:8080,destinationHost:'db',destinationPort:5432});
 assert.deepEqual(forwardConfig({type:'dynamic',listenPort:0}),{type:'dynamic',listenPort:0});
 for(const c of [{type:'unknown'},{type:'dynamic',listenPort:-1},{type:'local',destinationPort:0},{type:'remote',destinationHost:'bad host',destinationPort:80}])assert.throws(()=>forwardConfig(c));
});

test('remote forwarding through a jump host carries bytes and closes the listener on stop', {timeout:10000},async t=>{
 const jump=await setup(t),target=await setup(t),port=await echo(t),m=manager(t);
 const f=await m.startForward(target.host,target.credential,{type:'remote',listenPort:0,destinationHost:'127.0.0.1',destinationPort:port},[hop(jump)]);
 assert.equal(f.type,'remote');assert(f.port>0);assert.equal(target.bindings.get(f.port).server.address().address,'127.0.0.1');
 const s=await socket(t,f.port);assert.equal((await exchange(s,'from SSH server')).toString(),'from SSH server');
 m.stopForward(f.id);await eventually(()=>!target.bindings.size&&!jump.clients.size&&!target.clients.size);assert.equal(m.forwards.size,0);
});

test('remote forwarding denial and local address collision clean up the SSH connection', {timeout:10000},async t=>{
 const target=await setup(t,{allowRemote:false}),m=manager(t),occupied=await echo(t);
 await assert.rejects(m.startForward(target.host,target.credential,{type:'remote',listenPort:0,destinationPort:80}),/bind|forward|request/i);
 await assert.rejects(m.startForward(target.host,target.credential,{localPort:occupied,remotePort:80}),/EADDRINUSE/);
 assert.equal(m.forwards.size,0);await eventually(()=>!target.clients.size);
});

test('SOCKS5 supports fragmented negotiation, remote DNS and pipelined payload through a jump', {timeout:10000},async t=>{
 const jump=await setup(t),target=await setup(t),port=await echo(t),m=manager(t);
 const f=await m.startForward(target.host,target.credential,{type:'dynamic',listenPort:0},[hop(jump)]);
 const s=await socket(t,f.port);
 s.write(Buffer.from([5]));assert.deepEqual(await exchange(s,Buffer.from([1,0])),Buffer.from([5,0]));
 const hostname=Buffer.from('echo.internal.test'),request=Buffer.alloc(7+hostname.length);request.set([5,1,0,3,hostname.length]);hostname.copy(request,5);request.writeUInt16BE(port,5+hostname.length);
 const chunks=[];s.on('data',d=>chunks.push(d));s.write(request.subarray(0,6));s.write(Buffer.concat([request.subarray(6),Buffer.from('pipelined data')]));
 await eventually(()=>Buffer.concat(chunks).length>=10+14);
 const response=Buffer.concat(chunks);assert.equal(response[1],0);assert.equal(response.subarray(10).toString(),'pipelined data');assert.equal(target.forwardRequests[0].destIP,'echo.internal.test');
 m.closeAll();await eventually(()=>s.destroyed&&!target.clients.size&&!jump.clients.size);
});

test('SOCKS5 rejects unsupported authentication, commands, bad addresses and failed destinations', {timeout:10000},async t=>{
 const target=await setup(t,{denyChannel:true}),m=manager(t),f=await m.startForward(target.host,target.credential,{type:'dynamic',listenPort:0});
 const auth=await socket(t,f.port);assert.deepEqual(await exchange(auth,Buffer.from([5,1,2])),Buffer.from([5,255]));
 for(const [packet,code] of [[Buffer.from([5,3,0,1]),7],[Buffer.from([5,1,0,9]),8],[Buffer.from([5,1,0,3,0]),8],[Buffer.from([5,1,0,1,127,0,0,1,0,80]),5]]){
  const s=await socket(t,f.port);assert.deepEqual(await exchange(s,Buffer.from([5,1,0])),Buffer.from([5,0]));assert.equal((await exchange(s,packet))[1],code);s.destroy();
 }
});

test('a lost bastion closes an active proxy and its sockets', {timeout:10000},async t=>{
 const jump=await setup(t),target=await setup(t),m=manager(t),f=await m.startForward(target.host,target.credential,{type:'dynamic',listenPort:0},[hop(jump)]);
 const pending=await socket(t,f.port);pending.write(Buffer.from([5]));
 for(const client of jump.clients)client.end();
 await eventually(()=>m.forwards.size===0&&pending.destroyed&&!target.clients.size);
});

test('closing while the server delays remote binding cancels the pending start', {timeout:10000},async t=>{
 const target=await setup(t,{hangRemote:true}),m=manager(t);
 const attempt=m.startForward(target.host,target.credential,{type:'remote',listenPort:0,destinationPort:80}),rejected=assert.rejects(attempt,/closed/);
 await eventually(()=>target.remoteRequests.length);m.closeAll();await rejected;assert.equal(m.forwards.size,0);await eventually(()=>!target.clients.size);
});

test('SOCKS5 IPv4 and IPv6 requests preserve address and binary payload', {timeout:10000},async t=>{
 const target=await setup(t),port=await echo(t),m=manager(t),f=await m.startForward(target.host,target.credential,{type:'dynamic',listenPort:0});
 for(const [type,address,expected] of [[1,Buffer.from([127,0,0,1]),'127.0.0.1'],[4,Buffer.from('00000000000000000000000000000001','hex'),'0:0:0:0:0:0:0:1']]){
  const s=await socket(t,f.port);assert.deepEqual(await exchange(s,Buffer.from([5,1,0])),Buffer.from([5,0]));
  const request=Buffer.alloc(6+address.length);request.set([5,1,0,type]);address.copy(request,4);request.writeUInt16BE(port,4+address.length);
  assert.equal((await exchange(s,request))[1],0);
  const payload=Buffer.from([0,255,128,13,10,0,42]);assert.deepEqual(await exchange(s,payload),payload);
  assert.equal(target.forwardRequests.at(-1).destIP,expected);s.destroy();
 }
});

test('forwarded TCP responses survive a client half-close', {timeout:10000},async t=>{
 const sockets=new Set(),server=net.createServer({allowHalfOpen:true},s=>{
  sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));const received=[];
  s.on('data',d=>received.push(d));s.on('end',()=>setImmediate(()=>s.end(Buffer.concat(received))));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
 const target=await setup(t),m=manager(t),port=server.address().port;
 for(const type of ['local','remote','dynamic']){
  const f=await m.startForward(target.host,target.credential,{type,listenPort:0,destinationPort:port}),s=await socket(t,f.port);
  if(type==='dynamic'){
   await exchange(s,Buffer.from([5,1,0]));const req=Buffer.from([5,1,0,1,127,0,0,1,0,0]);req.writeUInt16BE(port,8);assert.equal((await exchange(s,req))[1],0);
  }
  const chunks=[];s.on('data',d=>chunks.push(d));const ended=once(s,'end');s.end('respond after EOF');await ended;
  assert.equal(Buffer.concat(chunks).toString(),'respond after EOF',type);m.stopForward(f.id);
 }
});
