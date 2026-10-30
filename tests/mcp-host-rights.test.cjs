'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {policy,allows,RIGHTS}=require('../electron/mcp/policy.cjs');
const {toolsFor}=require('../electron/mcp/tools.cjs');
const {rules,savedApprovals}=require('../electron/mcp/rules.cjs');
const {McpAccess}=require('../electron/mcp/access.cjs');

test('host overrides replace defaults, including empty rights, and tool discovery includes host-only grants',()=>{
 const p=policy({hostIds:['read','write','default','empty'],rights:['hosts','connect','exec'],hostRights:{read:['connect','files:read'],write:['connect','files:write'],empty:[]}});
 assert(allows(p,'exec','default'));assert(!allows(p,'exec','read'));assert(allows(p,'files:write','write'));assert(!allows(p,'files:write','read'));
 for(const right of RIGHTS){assert(!allows(p,right,'empty'));assert(!allows(p,right,'unselected'))}
 const names=toolsFor(p).map(t=>t.name);assert(names.includes('harbor_read_file'));assert(names.includes('harbor_write_file'));assert(!names.includes('harbor_list_files'));
 const allDenied=policy({hostIds:['one'],rights:RIGHTS,hostRights:{one:[]}});assert.deepEqual(toolsFor(allDenied),[]);
 p.rights.push('disconnect');assert(allows(p,'disconnect','default'));assert(!allows(p,'disconnect','read'));
 delete p.hostRights.read;assert(allows(p,'exec','read'));assert(!allows(p,'files:read','read'));
 for(const overrides of [null,[],{unselected:[]},{read:'exec'},{read:['vault:read']},{read:Array(9).fill('exec')}])assert.throws(()=>policy({...p,hostRights:overrides}),/host permissions/);
 assert.equal(Object.hasOwn(policy({hostIds:['__proto__'],rights:[],hostRights:JSON.parse('{"__proto__":["connect"]}')}).hostRights,'__proto__'),true);
});

async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-host-rights-')),effects=[];
 const readVault=async()=>({hosts:[{id:'one',label:'Read server',address:'one.invalid'},{id:'two',label:'Write server',address:'two.invalid'}]});
 const a=new McpAccess({dir,readVault});await a.create({name:'Host rights test'});const id=a.state.clients[0].id;
 a.ssh={describe:async hostId=>({digest:'stable',approvalDigest:'a'.repeat(64),target:{id:hostId,label:hostId,address:hostId+'.invalid',port:22,username:'test',via:[]}}),connect:async(hostId,digest,check)=>{check();effects.push('connect:'+hostId)},exec:async(id,command,check)=>{check();effects.push('exec:'+id);return {stdout:'ok'}},read:async(id,p,check)=>{check();effects.push('read:'+id);return {content:'ok'}},write:async(id,p,content,check)=>{check();effects.push('write:'+id);return {written:true}},close:()=>{},closeAll:()=>{}};
 const peer={client:a.state.clients[0],connectionId:'test-peer',socket:{destroyed:false}};
 const activate=()=>{a.state.enabled=true;a.active=true};
 return {a,id,dir,effects,peer,activate,async close(){await a.close();await fs.rm(dir,{recursive:true,force:true})}};
}

test('legacy defaults migrate without widening access; host permissions survive reload in downgrade-safe settings',async()=>{
 const f=await fixture();let loaded;
 try{
  const old={...f.a.state,version:1,clients:f.a.state.clients.map(c=>({...c,hostIds:['one','two'],rights:['hosts','connect']}))};
  await fs.writeFile(path.join(f.dir,'mcp-access.json'),JSON.stringify(old));
  await f.a.load();assert.equal(f.a.error,'');assert(allows(f.a.state.clients[0],'connect','one'));assert.deepEqual(f.a.state.clients[0].hostRights,{});
  await f.a.update(f.id,{hostIds:['one','two'],rights:['hosts','connect'],hostRights:{one:[],two:['files:read']}});
  const stored=JSON.parse(await fs.readFile(path.join(f.dir,'mcp-access.json'),'utf8'));assert.equal(stored.version,2); // Older builds accept version 1 only and must fail closed.
  loaded=new McpAccess({dir:f.dir,readVault:f.a.readVault});await loaded.load();assert.equal(loaded.error,'');assert(!allows(loaded.state.clients[0],'connect','one'));assert(allows(loaded.state.clients[0],'files:read','two'));assert(!allows(loaded.state.clients[0],'connect','two'));
  stored.clients[0].hostRights={outside:['exec']};await fs.writeFile(path.join(f.dir,'mcp-access.json'),JSON.stringify(stored));await loaded.close();loaded=new McpAccess({dir:f.dir,readVault:f.a.readVault});await loaded.load();assert(loaded.error);assert.equal(loaded.active,false);assert.deepEqual(loaded.state.clients,[]);
 }finally{await loaded?.close();await f.close()}
});

test('host rights filter metadata and block denied actions before prompts or remembered/headless approvals',async()=>{
 const f=await fixture(),{a,id,peer,effects}=f;
 try{
  await a.update(id,{hostIds:['one','two'],rights:RIGHTS,hostRights:{one:['connect','files:read']}});f.activate();
  const c=a.state.clients[0];
  for(const hostId of ['one','two'])a.sessions.set(hostId,{id:hostId,hostId,clientId:id,connectionId:peer.connectionId,status:'connected'});
  assert.deepEqual((await a.call(peer,'harbor_list_hosts',{})).hosts.map(h=>h.id),['two']);assert.deepEqual((await a.call(peer,'harbor_list_sessions',{})).sessions.map(s=>s.hostId),['two']);
  for(const headless of [false,true]){
   a.headless=headless;
   // Even stale remembered rules cannot bypass the host's base rights.
   c.approvals=[{rule:{tool:'harbor_exec',hostId:'one',scope:'all-commands'},binding:'a'.repeat(64)}];
   c.automations=[{tool:'harbor_exec',hostId:'one',scope:'all-commands',binding:'a'.repeat(64),destination:'test'}];
   await assert.rejects(a.call(peer,'harbor_exec',{sessionId:'one',command:'forbidden'}),/not permitted/);
   await assert.rejects(a.call(peer,'harbor_write_file',{sessionId:'one',path:'/file',content:'forbidden'}),/not permitted/);
   await assert.rejects(a.call(peer,'harbor_connect',{hostId:'outside'}),/not permitted/);
   assert.equal(a.pending.size,0);assert.deepEqual(effects,[]);
  }
  a.headless=false;c.approvals=[];c.automations=[];
  for(const headless of [false,true]){
   const allowed=[{tool:'harbor_read_file',hostId:'one',path:'/file'},{tool:'harbor_exec',hostId:'two',command:'allowed'},{tool:'harbor_write_file',hostId:'two',path:'/file'}];
   a.headless=headless;
   if(headless)c.automations=rules(c,allowed.map(rule=>({...rule,binding:'a'.repeat(64),destination:'test'})),{headless:true});else c.approvals=allowed.map(rule=>a.approvalEntry(c,rule,{approvalDigest:'a'.repeat(64),target:{address:'test',username:'test'}}));
   await a.call(peer,'harbor_read_file',{sessionId:'one',path:'/file'});await a.call(peer,'harbor_exec',{sessionId:'two',command:'allowed'});await a.call(peer,'harbor_write_file',{sessionId:'two',path:'/file',content:'allowed'});
   assert.equal(a.pending.size,0);
  }
  assert.deepEqual(effects,['read:one','exec:two','write:two','read:one','exec:two','write:two']);
  a.headless=false;await assert.rejects(a.addApproval(id,{tool:'harbor_exec',hostId:'one',command:'no'},true,'a'.repeat(64)),/permissions/);
  await assert.rejects(a.saveRules(id,[{tool:'harbor_write_file',hostId:'one',path:'/file'}],true),/permissions/);
  assert.throws(()=>savedApprovals(c,[{id:'11111111-1111-1111-1111-111111111111',rule:{tool:'harbor_exec',hostId:'one',command:'no'},binding:'a'.repeat(64),destination:'test'}]),/permissions/);
 }finally{await f.close()}
});

test('saving a host override cancels pending requests and clears existing sessions and rules',async()=>{
 const f=await fixture(),{a,id,peer}=f;
 try{
  await a.update(id,{hostIds:['one','two'],rights:['connect','exec']});f.activate();
  const result=a.call(peer,'harbor_connect',{hostId:'one'}),rejected=assert.rejects(result,/paused/);
  for(let i=0;i<100&&!a.pending.size;i++)await new Promise(r=>setTimeout(r,5));assert.equal(a.pending.size,1);
  a.sessions.set('existing',{hostId:'two',clientId:id,connectionId:peer.connectionId});a.sessionApprovals.set('temp',{clientId:id});a.state.clients[0].approvals=[{}];a.state.clients[0].automations=[{}];
  await a.update(id,{hostIds:['one','two'],rights:['connect','exec'],hostRights:{one:[]}});await rejected;
  assert.equal(a.active,false);assert.equal(a.pending.size,0);assert.equal(a.sessions.size,0);assert.equal(a.sessionApprovals.size,0);assert.deepEqual(a.state.clients[0].approvals,[]);assert.deepEqual(a.state.clients[0].automations,[]);
  f.activate();await assert.rejects(a.call(peer,'harbor_connect',{hostId:'one'}),/not permitted/);
 }finally{await f.close()}
});

test('clearing a host removes all its automatic permissions atomically and preserves other hosts and clients',async()=>{
 const f=await fixture();let reloaded;
 try{
  const {a,id}=f;await a.update(id,{hostIds:['one','two'],rights:['connect','exec'],hostRights:{one:['connect','exec']}});
  await a.addApproval(id,{hostId:'one',tool:'harbor_connect'},true,'a'.repeat(64));
  await a.addApproval(id,{hostId:'one',tool:'harbor_exec',command:'one-command'},true,'a'.repeat(64));
  await a.addApproval(id,{hostId:'two',tool:'harbor_connect'},true,'a'.repeat(64));
  await a.create({name:'Other client'});const otherId=a.state.clients[1].id;await a.update(otherId,{hostIds:['one'],rights:['connect']});await a.addApproval(otherId,{hostId:'one',tool:'harbor_connect'},true,'a'.repeat(64));
  f.activate();const before=structuredClone(a.state),policyBefore={rights:before.clients[0].rights,hostRights:before.clients[0].hostRights};
  await assert.rejects(a.clearHostApprovals('missing','one'),/Unknown client/);await assert.rejects(a.clearHostApprovals(id,'missing'),/Host not permitted/);assert.deepEqual(a.state,before);assert.equal(a.active,true);
  const readVault=a.readVault;a.readVault=async()=>{throw new Error('Locked')};await assert.rejects(a.clearHostApprovals(id,'one'),/Locked/);a.readVault=readVault;assert.deepEqual(a.state,before);
  a.sessions.set('session',{clientId:id,hostId:'one'});a.sessionApprovals.set('temporary',{clientId:id,rule:{hostId:'one',tool:'harbor_connect'}});
  let writes=0;const persist=a.persist.bind(a);a.persist=async next=>{writes++;await persist(next)};
  const result=await a.clearHostApprovals(id,'one');assert.equal(writes,1);assert.equal(result.active,false);assert.equal(a.sessions.size,0);assert.equal(result.temporaryApprovals.length,0);
  assert.deepEqual(a.state.clients[0].approvals,before.clients[0].approvals.filter(entry=>entry.rule.hostId==='two'));assert.deepEqual(a.state.clients[1],before.clients[1]);assert.deepEqual({rights:a.state.clients[0].rights,hostRights:a.state.clients[0].hostRights},policyBefore);
  assert(a.auditRecords.some(row=>row.clientId===id&&row.hostId==='one'&&row.status==='revoked'));
  reloaded=new McpAccess({dir:f.dir,readVault:a.readVault});await reloaded.load();assert.equal(reloaded.error,'');assert.deepEqual(reloaded.state,a.state);
 }finally{await reloaded?.close();await f.close()}
});
