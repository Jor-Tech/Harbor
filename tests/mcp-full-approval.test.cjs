'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {McpAccess}=require('../electron/mcp/access.cjs');
const {RIGHTS}=require('../electron/mcp/policy.cjs');
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-full-approval-'));let locked=false,binding='a'.repeat(64);
 const readVault=async()=>{if(locked)throw new Error('Locked');return {hosts:[{id:'one'},{id:'two'}]}};
 const a=new McpAccess({dir,readVault}),effects=[];await a.create({name:'Primary'});await a.create({name:'Other client'});
 for(const c of a.state.clients)await a.update(c.id,{hostIds:['one','two'],rights:RIGHTS});
 a.ssh={describe:async hostId=>({digest:'stable',approvalDigest:binding,target:{id:hostId,address:hostId+'.invalid',username:'test',port:22,via:[]}}),connect:async()=>effects.push('connect'),close:()=>effects.push('disconnect'),closeAll:()=>{},exec:async()=>({stdout:'ok'}),read:async()=>({content:'ok'}),list:async()=>({entries:[]}),write:async()=>({written:true})};
 const id=a.state.clients[0].id,peer={client:a.state.clients[0],connectionId:'test',socket:{destroyed:false}};
 return {a,id,peer,effects,setLocked:value=>{locked=value},setBinding:value=>{binding=value},activate(){a.state.enabled=true;a.active=true},async close(){await a.close();await fs.rm(dir,{recursive:true,force:true})}};
}
async function deny(a,operation){const rejected=assert.rejects(operation,{code:"REQUEST_DENIED"});for(let n=0;n<100&&!a.pending.size;n++)await new Promise(r=>setTimeout(r,5));assert.equal(a.pending.size,1);a.answer([...a.pending.keys()][0],false);await rejected;}

test('full approval is atomic, client/host/account bound, durable and separate from headless',async()=>{
 const f=await fixture(),{a,id,peer}=f;let loaded;
 try{
  const otherId=a.state.clients[1].id;
  for(const [clientId,hostId] of [[id,'one'],[id,'two'],[otherId,'one']])await a.addApproval(clientId,{hostId,tool:'harbor_connect'},true,'a'.repeat(64));
  const other=structuredClone(a.state.clients[1]),otherHost=structuredClone(a.state.clients[0].approvals.filter(e=>e.rule.hostId==='two'));
  const before=structuredClone(a.state);f.activate();
  for(const [clientId,hostId,confirm,binding] of [[id,'one',false,'a'.repeat(64)],[id,'one',true,'b'.repeat(64)],[id,'outside',true,'a'.repeat(64)],['missing','one',true,'a'.repeat(64)]])await assert.rejects(a.addFullApproval(clientId,hostId,confirm,binding));
  f.setLocked(true);await assert.rejects(a.addFullApproval(id,'one',true,'a'.repeat(64)),/Locked/);f.setLocked(false);
  assert.deepEqual(a.state.clients,before.clients);assert.equal(a.active,true);
  let writes=0;const persist=a.persist.bind(a);a.persist=async next=>{writes++;await persist(next)};
  await a.addFullApproval(id,'one',true,'a'.repeat(64));assert.equal(writes,1);assert.equal(a.active,false);
  assert.deepEqual(a.state.clients[1],other);assert.deepEqual(a.state.clients[0].approvals.filter(e=>e.rule.hostId==='two'),otherHost);assert.equal(a.state.clients[0].approvals.filter(e=>e.rule.hostId==='one').length,6);
  assert.deepEqual(a.state.clients[0].automations,[]);assert.deepEqual(a.state.clients[0].rights,RIGHTS);
  f.activate();const {sessionId}=await a.call(peer,'harbor_connect',{hostId:'one'});
  for(const [tool,args] of [['harbor_exec',{command:'arbitrary command'}],['harbor_read_file',{path:'/any/nested/file'}],['harbor_list_files',{path:'/any/folder'}],['harbor_write_file',{path:'/any/nested/file',content:'updated'}],['harbor_disconnect',{}]])await a.call(peer,tool,{sessionId,...args});
  assert.equal(a.pending.size,0);assert.equal(a.sessions.size,0);
  const otherSession=await a.call(peer,'harbor_connect',{hostId:'two'});await deny(a,a.call(peer,'harbor_exec',{sessionId:otherSession.sessionId,command:'not automatically allowed'}));
  const otherPeer={...peer,client:a.state.clients[1],connectionId:'other-client'};const otherClientSession=await a.call(otherPeer,'harbor_connect',{hostId:'one'});await deny(a,a.call(otherPeer,'harbor_read_file',{sessionId:otherClientSession.sessionId,path:'/any/file'}));
  f.setBinding('b'.repeat(64));await deny(a,a.call(peer,'harbor_connect',{hostId:'one'}));f.setBinding('a'.repeat(64));
  loaded=new McpAccess({dir:a.dir,readVault:a.readVault});await loaded.load();assert.equal(loaded.error,'');assert.equal(loaded.active,false);assert.equal(loaded.state.clients[0].approvals.length,7);
  loaded.ssh=a.ssh;loaded.state.enabled=true;loaded.active=true;loaded.headless=true;await assert.rejects(loaded.call(peer,'harbor_connect',{hostId:'one'}),/Headless rule/);
  await a.clearHostApprovals(id,'one');assert.deepEqual(a.state.clients[0].approvals,otherHost);f.activate();await deny(a,a.call(peer,'harbor_connect',{hostId:'one'}));
 }finally{await loaded?.close();await f.close()}
});

test('full approval cannot widen action rights, exceed capacity, survive stale review or partially persist',async()=>{
 const f=await fixture(),{a,id}=f;
 try{
  await a.update(id,{hostIds:['one','two'],rights:RIGHTS,hostRights:{one:['connect']}});
  await assert.rejects(a.addFullApproval(id,'one',true,'a'.repeat(64)),/permissions/);assert.deepEqual(a.state.clients[0].approvals,[]);
  await a.update(id,{hostIds:['one','two'],rights:RIGHTS});
  for(let n=0;n<15;n++)await a.addApproval(id,{hostId:'two',tool:'harbor_exec',command:'command '+n},true,'a'.repeat(64));
  let before=structuredClone(a.state);await assert.rejects(a.addFullApproval(id,'one',true,'a'.repeat(64)),/20 saved/);assert.deepEqual(a.state,before);
  await a.clearHostApprovals(id,'two');before=structuredClone(a.state);
  const persist=a.persist;a.persist=async()=>{throw new Error('Disk failed')};await assert.rejects(a.addFullApproval(id,'one',true,'a'.repeat(64)),/Disk failed/);assert.deepEqual(a.state,before);a.persist=persist;
  const describe=a.ssh.describe;a.ssh.describe=async hostId=>{a.pause();return describe(hostId)};await assert.rejects(a.addFullApproval(id,'one',true,'a'.repeat(64)),/Access changed/);assert.deepEqual(a.state,before);a.ssh.describe=describe;
  a.headless=true;await assert.rejects(a.addFullApproval(id,'one',true,'a'.repeat(64)),/Harbor window/);a.headless=false;
  await a.addFullApproval(id,'one',true,'a'.repeat(64));await a.update(id,{hostIds:['one','two'],rights:RIGHTS});assert.deepEqual(a.state.clients[0].approvals,[]);
 }finally{await f.close()}
});
