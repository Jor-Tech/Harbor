'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {McpAccess}=require('../electron/mcp/access.cjs');
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-'));const a=new McpAccess({dir,readVault:async()=>({hosts:[{id:'one'}]})});await a.create({name:'Test'});const c=a.state.clients[0];c.hostIds=['one'];c.rights=['connect','exec','files:read','disconnect'];a.state.enabled=true;a.active=true;const peer={client:c,connectionId:'connection',socket:{destroyed:false}};const effects=[];
 a.ssh={describe:async()=>({digest:'stable',approvalDigest:'a'.repeat(64),target:{id:'one',label:'Test',address:'test.invalid',port:22,username:'test',via:[]}}),connect:async(...args)=>{args[2]();effects.push('connect')},exec:async(id,command,check)=>{check();effects.push(command);return {stdout:'result'}},close:()=>{},closeAll:()=>{}};
 return {a,peer,effects,async close(){await a.close();await fs.rm(dir,{recursive:true,force:true})}};
}
async function pending(a){for(let i=0;i<100&&!a.pending.size;i++)await new Promise(r=>setTimeout(r,5));assert.equal(a.pending.size,1);return [...a.pending.values()][0];}
test('actions require exact single-use approval and sessions cannot be borrowed',async()=>{
 const f=await fixture(),{a,peer,effects}=f;try{
  const connection=a.call(peer,'harbor_connect',{hostId:'one'});const p=await pending(a);assert.equal(a.snapshot().pending[0].clientId,peer.client.id);assert.deepEqual(effects,[]);assert.throws(()=>a.answer(p.id,true,false));a.answer(p.id,true,true);const {sessionId}=await connection;assert.deepEqual(effects,['connect']);assert.throws(()=>a.answer(p.id,true,true));
  const args={sessionId,command:'original'},operation=a.call(peer,'harbor_exec',args);await pending(a);args.command='modified';a.answer([...a.pending.keys()][0],true,true);await operation;assert.deepEqual(effects,['connect','original']);
  await assert.rejects(a.call({...peer,connectionId:'other'},'harbor_exec',{sessionId,command:'steal'}));
  const denied=a.call(peer,'harbor_exec',{sessionId,command:'denied'});const reject=assert.rejects(denied);a.answer((await pending(a)).id,false);await reject;assert(!effects.includes('denied'));await a.auditWrite;const log=await fs.readFile(path.join(a.dir,'mcp-audit.json'),'utf8');assert(!log.includes('original'));assert(!log.includes('modified'));assert(log.includes('approved'));assert(a.auditRecords.length<=200);
 }finally{await f.close()}
});

test('temporary exact approvals reuse a connection but never another command, client or client connection',async()=>{
 const f=await fixture(),{a,peer,effects}=f;
 try{
  const connect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true,'session');const {sessionId}=await connect;
  await a.call(peer,'harbor_connect',{hostId:'one'});assert.equal(a.pending.size,0);
  const exec=a.call(peer,'harbor_exec',{sessionId,command:'uptime'});a.answer((await pending(a)).id,true,true,'session');await exec;
  await a.call(peer,'harbor_exec',{sessionId,command:'uptime'});assert.equal(a.pending.size,0);assert.equal(a.sessionApprovals.size,2);
  const changed=a.call(peer,'harbor_exec',{sessionId,command:'uptime; id'}),denied=assert.rejects(changed);a.answer((await pending(a)).id,false);await denied;assert(!effects.includes('uptime; id'));
  const otherConnection={...peer,connectionId:'other'};const other=a.call(otherConnection,'harbor_connect',{hostId:'one'}),otherDenied=assert.rejects(other);a.answer((await pending(a)).id,false);await otherDenied;
  const another={...peer.client,id:'another'};a.state.clients.push(another);const otherClient=a.call({...peer,client:another},'harbor_connect',{hostId:'one'}),clientDenied=assert.rejects(otherClient);a.answer((await pending(a)).id,false);await clientDenied;
  const stored=await fs.readFile(path.join(a.dir,'mcp-access.json'),'utf8');assert(!stored.includes('uptime'));
  a.disconnect(peer);assert.equal(a.sessionApprovals.size,0);assert.equal(a.sessions.size,0);
 }finally{await f.close()}
});

test('saved exact approvals survive reload, require unchanged destination and do not become headless rules',async()=>{
 const f=await fixture(),{a,peer}=f;let reload;
 try{
  const connect=a.call(peer,'harbor_connect',{hostId:'one'});await a.answer((await pending(a)).id,true,true,'always');await connect;
  assert.equal(a.state.clients[0].approvals.length,1);a.pause();assert.equal(a.sessionApprovals.size,0);a.active=true;
  await a.call(peer,'harbor_connect',{hostId:'one'});assert.equal(a.pending.size,0);
  reload=new McpAccess({dir:a.dir,readVault:a.readVault});await reload.load();assert.equal(reload.error,'');assert.equal(reload.state.clients[0].approvals.length,1);
  reload.ssh=a.ssh;reload.active=true;await reload.call(peer,'harbor_connect',{hostId:'one'});assert.equal(reload.pending.size,0);
  reload.headless=true;await assert.rejects(reload.call(peer,'harbor_connect',{hostId:'one'}),/Headless rule/);reload.headless=false;
  const describe=a.ssh.describe;a.ssh.describe=async()=>({...await describe(),approvalDigest:'b'.repeat(64)});
  const changed=reload.call(peer,'harbor_connect',{hostId:'one'}),denied=assert.rejects(changed);reload.answer((await pending(reload)).id,false);await denied;
 }finally{await reload?.close();await f.close()}
});

test('saved broad commands require explicit settings, respect host rights, and revoke in-flight output',async()=>{
 const f=await fixture(),{a,peer}=f;let complete;
 try{
  await assert.rejects(a.addApproval(peer.client.id,{tool:'harbor_exec',hostId:'one',scope:'all-commands'},false));
  await assert.rejects(a.addApproval(peer.client.id,{tool:'harbor_exec',hostId:'other',scope:'all-commands'},true));
  assert.equal((await a.previewApproval(peer.client.id,'one')).target.address,'test.invalid');await assert.rejects(a.addApproval(peer.client.id,{tool:'harbor_exec',hostId:'one',scope:'all-commands'},true,'b'.repeat(64)),/target changed/);
  await a.addApproval(peer.client.id,{tool:'harbor_exec',hostId:'one',scope:'all-commands'},true,'a'.repeat(64));assert.equal(a.active,false);a.active=true;
  const connect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true);const {sessionId}=await connect;
  await a.call(peer,'harbor_exec',{sessionId,command:'arbitrary command'});assert.equal(a.pending.size,0);
  a.ssh.exec=()=>new Promise(resolve=>{complete=resolve});const running=a.call(peer,'harbor_exec',{sessionId,command:'in flight'}),rejected=assert.rejects(running);
  while(!complete)await new Promise(r=>setImmediate(r));await a.removeApproval(peer.client.id,a.state.clients[0].approvals[0].id);complete({stdout:'DO_NOT_RELEASE'});await rejected;
  assert.equal(a.active,false);assert.equal(a.state.clients[0].approvals.length,0);assert.equal(a.sessions.size,0);
 }finally{await f.close()}
});

test('lock and permission edits clear temporary rules; writes require scope consent and denied requests cannot be remembered',async()=>{
 const f=await fixture(),{a,peer}=f;
 try{
  for(const reason of ['lock','policy','remove']){
   a.active=true;const connect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true,'session');await connect;
   if(reason==='lock')a.pause();else if(reason==='remove')await a.removeApproval(peer.client.id,[...a.sessionApprovals.keys()][0]);else await a.update(peer.client.id,{hostIds:['one'],rights:['connect','exec','files:write']});
   assert.equal(a.sessionApprovals.size,0);
  }
  a.active=true;const connect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true);const {sessionId}=await connect;
  const write=a.call(peer,'harbor_write_file',{sessionId,path:'/tmp/test',content:'secret'}),denied=assert.rejects(write);const p=await pending(a);
  assert.throws(()=>a.answer(p.id,true,true,'always'));assert.throws(()=>a.answer(p.id,true,true,'session'));a.answer(p.id,false,true,'always');await denied;
  assert.equal(a.state.clients[0].approvals?.length||0,0);assert.equal(a.sessionApprovals.size,0);
 }finally{await f.close()}
});

test('saving failure and cancellation before saving cannot grant a standing permission',async()=>{
 for(const reason of ['disk','cancel']){
  const f=await fixture(),{a,peer,effects}=f;let release;
  try{
   const controller=new AbortController(),operation=a.call(peer,'harbor_connect',{hostId:'one'},controller.signal),rejected=assert.rejects(operation);const p=await pending(a);
   if(reason==='disk')a.persist=async()=>{throw new Error('Disk failure')};else a.queue=new Promise(resolve=>{release=resolve});
   const saving=a.answer(p.id,true,true,'always'),saveRejected=assert.rejects(saving);
   if(reason==='cancel'){controller.abort();release();}await saveRejected;
   if(reason==='disk')a.answer(p.id,false);await rejected;assert.deepEqual(effects,[]);assert.equal(a.state.clients[0].approvals?.length||0,0);
  }finally{release?.();await f.close()}
 }
});

test('a remembered file read allows only its exact path and changing host rights clears saved grants',async()=>{
 const f=await fixture(),{a,peer}=f;
 try{
  a.ssh.read=async(_id,path,check)=>{check();return {content:path}};
  const connect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true);const {sessionId}=await connect;
  const read=a.call(peer,'harbor_read_file',{sessionId,path:'/tmp/one'});await a.answer((await pending(a)).id,true,true,'always');await read;
  assert.deepEqual(await a.call(peer,'harbor_read_file',{sessionId,path:'/tmp/one'}),{content:'/tmp/one'});
  const other=a.call(peer,'harbor_read_file',{sessionId,path:'/tmp/two'}),denied=assert.rejects(other);a.answer((await pending(a)).id,false);await denied;
  await a.update(peer.client.id,{hostIds:['one'],rights:['connect']});assert.equal(a.state.clients[0].approvals.length,0);assert.equal(a.active,false);
 }finally{await f.close()}
});
test('lock, client disconnect and cancellation discard pending actions',async()=>{
 for(const reason of ['lock','disconnect','cancel']){const f=await fixture();try{const controller=new AbortController(),p=f.a.call(f.peer,'harbor_connect',{hostId:'one'},controller.signal),rejected=assert.rejects(p);await pending(f.a);
  if(reason==='lock')f.a.pause({keepClients:true});else if(reason==='disconnect')f.a.disconnect(f.peer);else controller.abort();await rejected;assert.equal(f.a.pending.size,0);assert.deepEqual(f.effects,[]);
 }finally{await f.close()}}
});

test('revoking access while a command runs discards its returned output',async()=>{
 const f=await fixture();let complete;try{
  const {a,peer}=f;const connect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true);const {sessionId}=await connect;
  a.ssh.exec=()=>new Promise(resolve=>{complete=resolve});
  const p=a.call(peer,'harbor_exec',{sessionId,command:'running'}),rejected=assert.rejects(p);a.answer((await pending(a)).id,true,true);
  for(let i=0;i<100&&!complete;i++)await new Promise(r=>setTimeout(r,5));assert(complete);a.pause({keepClients:true});complete({stdout:'DO_NOT_RELEASE'});await rejected;
  assert.equal(a.active,false);assert.equal(a.sessions.size,0);
 }finally{await f.close()}
});

test('SSH authentication survives 30 seconds, remains bounded, and cancellation still closes it',async t=>{
 for(const reason of ['timeout','cancel']){
  const f=await fixture(),controller=new AbortController();let entered=false,closed=false,finish;
  try{
   f.a.ssh.connect=()=>new Promise((resolve,reject)=>{entered=true;finish=reject});
   f.a.ssh.close=()=>{closed=true;finish?.(new Error('Connection closed'))};
   t.mock.timers.enable({apis:['setTimeout']});
   const operation=f.a.call(f.peer,'harbor_connect',{hostId:'one'},controller.signal),rejected=assert.rejects(operation);
   while(!f.a.pending.size)await new Promise(r=>setImmediate(r));
   f.a.answer([...f.a.pending.keys()][0],true,true);
   while(!entered)await new Promise(r=>setImmediate(r));
   t.mock.timers.tick(30001);assert.equal(closed,false);
   if(reason==='timeout')t.mock.timers.tick(150000);else controller.abort();
   await rejected;assert.equal(closed,true);assert.equal(f.a.sessions.size,0);
  }finally{t.mock.timers.reset();await f.close()}
 }
});

test('saved GUI writes require explicit rights and consent, isolate clients/accounts/modes, survive load and revoke in flight',async()=>{
 const f=await fixture(),{a,peer,effects}=f;let reload,complete;
 try{
  const rule={tool:'harbor_write_file',hostId:'one',scope:'directory',path:'/work'},binding='a'.repeat(64);
  await assert.rejects(a.addApproval(peer.client.id,rule,true,binding),/permissions/);peer.client.rights.push('files:write');
  await assert.rejects(a.addApproval(peer.client.id,rule,false,binding),/Confirm/);
  await assert.rejects(a.addApproval(peer.client.id,rule,true,'b'.repeat(64)),/target changed/);
  await a.addApproval(peer.client.id,rule,true,binding);assert.equal(a.active,false);
  reload=new McpAccess({dir:a.dir,readVault:a.readVault});await reload.load();assert.equal(reload.error,'');assert.deepEqual(reload.state.clients[0].approvals[0].rule,rule);
  a.active=true;a.ssh.write=async(_id,path,content,check)=>{check();effects.push({path,content});return {written:true}};
  const connect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true);const {sessionId}=await connect;
  for(const content of ['first','replaced'])assert.deepEqual(await a.call(peer,'harbor_write_file',{sessionId,path:'/work/file',content}),{written:true});assert.equal(a.pending.size,0);
  const denyWrite=async path=>{const request=a.call(peer,'harbor_write_file',{sessionId,path,content:'DENIED'}),denied=assert.rejects(request);a.answer((await pending(a)).id,false);await denied;};
  await denyWrite('/worker/file');assert(!effects.some(e=>e.content==='DENIED'));
  const describe=a.ssh.describe;a.ssh.describe=async()=>({...await describe(),approvalDigest:'b'.repeat(64)});await denyWrite('/work/file');a.ssh.describe=describe;
  const other={...a.state.clients[0],id:'other',approvals:[]};a.state.clients.push(other);const otherPeer={...peer,client:other};a.sessions.set('other-session',{id:'other-session',hostId:'one',clientId:'other',connectionId:peer.connectionId});
  const otherRequest=a.call(otherPeer,'harbor_write_file',{sessionId:'other-session',path:'/work/file',content:'DENIED'}),otherDenied=assert.rejects(otherRequest);a.answer((await pending(a)).id,false);await otherDenied;
  a.headless=true;await assert.rejects(a.call(peer,'harbor_write_file',{sessionId,path:'/work/file',content:'DENIED'}),/Headless rule/);a.headless=false;
  a.ssh.write=()=>new Promise(resolve=>{complete=resolve});const writing=a.call(peer,'harbor_write_file',{sessionId,path:'/work/file',content:'IN_FLIGHT'}),rejected=assert.rejects(writing);
  while(!complete)await new Promise(r=>setImmediate(r));await a.removeApproval(peer.client.id,a.state.clients[0].approvals[0].id);complete({written:true});await rejected;assert.equal(a.active,false);assert.equal(a.state.clients[0].approvals.length,0);
 }finally{await reload?.close();await f.close()}
});


test('pending writes require explicit scope consent and bind temporary/saved grants to destination and scope',async()=>{
 for(const duration of ['session','always'])for(const scope of ['exact','directory']){
  const f=await fixture(),{a,peer,effects}=f;
  try{
   peer.client.rights.push('files:write');
   a.ssh.write=async(id,path,content,check)=>{check();effects.push({path,content});return {written:true}};
   const connect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true);const {sessionId}=await connect;
   const write=a.call(peer,'harbor_write_file',{sessionId,path:'/work/file',content:'FIRST'}),p=await pending(a);
   for(const permission of [undefined,{}, {confirm:false,scope}, {confirm:true,scope:'all-paths'}, {confirm:true,scope,path:'/'}])assert.throws(()=>a.answer(p.id,true,true,duration,permission));
   assert.equal(effects.length,1);assert.equal(a.sessionApprovals.size,0);assert.equal(a.state.clients[0].approvals?.length||0,0);
   await a.answer(p.id,true,true,duration,{confirm:true,scope});await write;
   const entry=duration==='session'?[...a.sessionApprovals.values()][0]:a.state.clients[0].approvals[0];
   assert.deepEqual(entry.rule,{tool:'harbor_write_file',hostId:'one',path:scope==='exact'?'/work/file':'/work',...(scope==='directory'?{scope}:{})});
   assert.equal(entry.binding,'a'.repeat(64));assert(!JSON.stringify(entry).includes('FIRST'));
   const target=scope==='exact'?'/work/file':'/work/sub/other';await a.call(peer,'harbor_write_file',{sessionId,path:target,content:'SECOND'});assert.equal(a.pending.size,0);
   const outside=scope==='exact'?'/work/other':'/worker/file';
   const blocked=a.call(peer,'harbor_write_file',{sessionId,path:outside,content:'BLOCKED'}),rejected=assert.rejects(blocked);a.answer((await pending(a)).id,false);await rejected;
   const describe=a.ssh.describe;a.ssh.describe=async()=>({...await describe(),approvalDigest:'b'.repeat(64)});
   const changed=a.call(peer,'harbor_write_file',{sessionId,path:target,content:'CHANGED'}),changedRejected=assert.rejects(changed);a.answer((await pending(a)).id,false);await changedRejected;
   assert(!effects.some(e=>e.content==='BLOCKED'||e.content==='CHANGED'));a.ssh.describe=describe;
   a.disconnect(peer);assert.equal(a.sessionApprovals.size,0);
   const reconnect=a.call(peer,'harbor_connect',{hostId:'one'});a.answer((await pending(a)).id,true,true);const next=await reconnect;
   const after=a.call(peer,'harbor_write_file',{sessionId:next.sessionId,path:target,content:'AFTER'});
   if(duration==='session'){const rejected=assert.rejects(after);a.answer((await pending(a)).id,false);await rejected}else{await after;assert.equal(a.pending.size,0)}
  }finally{await f.close()}
 }
});


test('expired approvals are distinguishable from denial and execution failure without exposing arbitrary errors',async t=>{
 const f=await fixture(),{a,peer}=f;
 try{
  const {publicError,ActionError}=require('../electron/mcp/errors.cjs');
  t.mock.timers.enable({apis:['setTimeout']});
  const operation=a.approve(peer,'harbor_connect',{hostId:'one'},await a.ssh.describe('one'));
  const rejected=assert.rejects(operation,{code:'APPROVAL_EXPIRED'});t.mock.timers.tick(120001);await rejected;
  assert.equal(a.auditRecords.at(-1).errorCode,'APPROVAL_EXPIRED');assert.equal(a.pending.size,0);
  assert.equal(publicError(new ActionError('REQUEST_DENIED')).code,'REQUEST_DENIED');
  const untrusted=Object.assign(new Error('password=DO_NOT_SHARE'),{code:'REQUEST_DENIED'});
  assert.equal(publicError(untrusted).code,'REQUEST_FAILED');assert(!JSON.stringify(publicError(untrusted)).includes('DO_NOT_SHARE'));
  t.mock.timers.reset();await a.auditWrite;await a.loadAudit();assert.equal(a.auditRecords.at(-1).errorCode,'APPROVAL_EXPIRED');
 }finally{t.mock.timers.reset();await f.close()}
});
