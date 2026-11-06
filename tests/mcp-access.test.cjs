'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {McpAccess}=require('../electron/mcp/access.cjs');
test('background status is published only when persistence cleanup has completed',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-background-'));let changes=0,release,entered,updating;
 const held=new Promise(resolve=>{release=resolve}),cleaning=new Promise(resolve=>{entered=resolve});
 const a=new McpAccess({dir,readVault:async()=>({hosts:[]}),onChange:()=>{changes++}}),rm=fs.rm;
 const mock=t.mock.method(fs,'rm',async(file,options)=>{
  if(String(file).startsWith(path.join(dir,'mcp-access.json.'))&&String(file).endsWith('.tmp')){entered();await held;}
  return rm(file,options);
 });
 try{
  updating=a.setBackground(true);await cleaning;
  assert.equal(a.snapshot().background,false,'Polling must not see background enabled before the tray update can run');
  assert.equal(changes,0);release();await updating;
  assert.equal(a.snapshot().background,true);assert.equal(changes,1);
 }finally{release();await updating?.catch(()=>{});mock.mock.restore();await a.close();await fs.rm(dir,{recursive:true,force:true})}
});
test('client pairing persists only hashes and policy edits pause access',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-'));let locked=false;
 const access=new McpAccess({dir,readVault:async()=>{if(locked)throw new Error('Locked');return {hosts:[{id:'one'}]}},bridgePath:'/bridge.cjs'});
 try{
  await access.load();assert.equal(access.snapshot().enabled,false);await access.create({name:'Test app'});
  const c=access.state.clients[0],credential=JSON.parse(await fs.readFile(access.credentialPath(c.id),'utf8'));
  assert.equal(JSON.stringify(access.snapshot()).includes(credential.token),false);
  assert.equal((await fs.readFile(path.join(dir,'mcp-access.json'),'utf8')).includes(credential.token),false);
  await access.setEnabled(true);assert.equal(access.authenticate(credential).id,c.id);
  assert.throws(()=>access.authenticate({...credential,token:'0'.repeat(64)}));
  await access.update(c.id,{hostIds:['one'],rights:['hosts']});assert.equal(access.active,false);assert.throws(()=>access.authenticate(credential));
  await access.resume();locked=true;access.pause();await assert.rejects(access.resume());locked=false;
  assert.equal(access.active,false);await access.resume();await access.revoke(c.id);await access.resume();assert.throws(()=>access.authenticate(credential));
 }finally{await access.close();await fs.rm(dir,{recursive:true,force:true})}
});
test('corrupt MCP configuration fails closed',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-'));await fs.writeFile(path.join(dir,'mcp-access.json'),'broken');const a=new McpAccess({dir,readVault:async()=>({hosts:[]})});
 try{await a.load();assert(a.error);await assert.rejects(a.setEnabled(true));assert.equal(a.active,false);}finally{await a.close();await fs.rm(dir,{recursive:true,force:true})}
});
test('locking while the endpoint starts cannot silently resume MCP',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-'));let locked=false,started,finish;
 const a=new McpAccess({dir,readVault:async()=>{if(locked)throw new Error('Locked');return {hosts:[]}}});a.state.enabled=true;a.server.start=()=>new Promise(resolve=>{started=true;finish=resolve});
 try{const p=a.resume(),rejected=assert.rejects(p);for(let i=0;i<100&&!started;i++)await new Promise(r=>setTimeout(r,5));assert(started);locked=true;a.pause();finish();await rejected;assert.equal(a.active,false);}finally{await a.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('clearing activity requires local unlocked confirmation and persists per-client/all changes during logging',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-audit-'));let locked=false;
 const a=new McpAccess({dir,readVault:async()=>{if(locked)throw new Error('Locked');return {hosts:[]}}});
 try{
  await a.create({name:'One'});await a.create({name:'Two'});const [one,two]=a.state.clients;
  for(let i=0;i<10;i++){a.record(one.id,'harbor_exec','completed');a.record(two.id,'harbor_read_file','completed');}
  await assert.rejects(a.clearAudit(one.id,false),/Confirm/);assert.equal(a.auditRecords.length,20);
  locked=true;await assert.rejects(a.clearAudit(null,true),/Locked/);locked=false;
  a.headless=true;await assert.rejects(a.clearAudit(null,true),/Harbor window/);a.headless=false;
  await assert.rejects(a.clearAudit('missing',true),/Unknown/);await assert.rejects(a.clearAudit(undefined,true),/Unknown/);
  const clearing=a.clearAudit(one.id,true);a.record(two.id,'client','disconnected');await clearing;
  assert.equal(a.auditRecords.length,11);assert(a.auditRecords.every(r=>r.clientId===two.id));assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'mcp-audit.json'),'utf8')),a.auditRecords);
  const reloaded=new McpAccess({dir,readVault:async()=>({hosts:[]})});await reloaded.loadAudit();assert.deepEqual(reloaded.auditRecords,a.auditRecords);await reloaded.close();
  assert.equal(a.active,false);await a.clearAudit(null,true);assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'mcp-audit.json'),'utf8')),[]);
  a.record(two.id,'client','disconnected');await a.auditWrite;assert.equal(JSON.parse(await fs.readFile(path.join(dir,'mcp-audit.json'),'utf8')).length,1);
 }finally{await a.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('renaming a client changes only its label, persists, and updates connected and pending client names',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-rename-'));let locked=false,reloaded;
 const a=new McpAccess({dir,readVault:async()=>{if(locked)throw new Error('Locked');return {hosts:[{id:'one'}]}}});
 try{
  await a.create({name:'Original'});const id=a.state.clients[0].id;await a.update(id,{hostIds:['one'],rights:['hosts','connect']});await a.create({name:'Other'});await a.update(a.state.clients[1].id,{hostIds:[],rights:[]});
  const client=a.state.clients[0],credential=await fs.readFile(a.credentialPath(id),'utf8');a.state.enabled=true;a.active=true;
  const peer={client,connectionId:'connected',socket:{destroyed:false}};a.server.peers.set('connected',peer);a.pending.set('pending',{id:'pending',peer,clientName:'Original',tool:'harbor_connect',args:{hostId:'one'},target:{id:'one'},expires:Date.now()+10000,finish:()=>a.pending.delete('pending')});a.sessionApprovals.set('temporary',{clientId:id,rule:{hostId:'one',tool:'harbor_connect'}});a.sessions.set('session',{clientId:id,hostId:'one'});
  const before=structuredClone(a.state),epoch=a.epoch;
  for(const invalid of ['', '   ', 'x'.repeat(81),null,5])await assert.rejects(a.rename(id,invalid),/Invalid text/);await assert.rejects(a.rename('missing','Name'),/Unknown client/);locked=true;await assert.rejects(a.rename(id,'Name'),/Locked/);locked=false;assert.deepEqual(a.state,before);
  const result=await a.rename(id,'  Renamed app  ');assert.equal(result.clients[0].name,'Renamed app');assert.equal(result.connections[0].name,'Renamed app');assert.equal(result.pending[0].client,'Renamed app');assert.equal(result.active,true);assert.equal(a.epoch,epoch);assert.equal(a.sessions.size,1);assert.equal(a.sessionApprovals.size,1);assert.equal(a.pending.size,1);
  assert.deepEqual(a.state,{...before,clients:before.clients.map(c=>c.id===id?{...c,name:'Renamed app'}:c)});assert.equal(await fs.readFile(a.credentialPath(id),'utf8'),credential);
  reloaded=new McpAccess({dir,readVault:a.readVault});await reloaded.load();assert.equal(reloaded.error,'');assert.deepEqual(reloaded.state,a.state);
  a.pending.clear();a.server.peers.clear();
 }finally{a.pending.clear();a.server.peers.clear();await reloaded?.close();await a.close();await fs.rm(dir,{recursive:true,force:true})}
});
