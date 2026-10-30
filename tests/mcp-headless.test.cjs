'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {rules,matches}=require('../electron/mcp/rules.cjs'),{acquireRuntime}=require('../electron/runtime-lock.cjs');
const {Vault}=require('../electron/vault.cjs'),{McpAccess}=require('../electron/mcp/access.cjs'),{startHeadless,resolveConnection}=require('../electron/mcp/headless.cjs'),{McpSsh}=require('../electron/mcp/ssh.cjs');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
test('headless rules use exact equality and cannot exceed ordinary host rights',()=>{
 const c={hostIds:['one'],rights:['exec'],automations:[{tool:'harbor_exec',hostId:'one',command:'uptime'}]};assert(matches(c,'harbor_exec','one',{command:'uptime'}));assert(!matches(c,'harbor_exec','one',{command:'uptime; id'}));assert.throws(()=>rules(c,[{tool:'harbor_exec',hostId:'other',command:'uptime'}]));assert.throws(()=>rules(c,[{tool:'harbor_write_file',hostId:'one',path:'/test'}]));
});
test('GUI and headless runtimes cannot own the same profile',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-owner-'));const release=acquireRuntime(dir);try{assert.throws(()=>acquireRuntime(dir),/already running/);}finally{release();await fs.rm(dir,{recursive:true,force:true})}
});
test('headless starts locked, uses local unlock callback and refuses missing approval rules',{timeout:10000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-headless-')),password='Harbor-headless-fixture';let runtime,client;
 const vault=new Vault(path.join(dir,'vault.hbr'));await vault.create(password);const d=await vault.read();d.hosts.push({id:'one',label:'Fixture',address:'127.0.0.1',port:1,username:'test'});await vault.save(d);vault.lock();
 const setup=new McpAccess({dir,readVault:async()=>({hosts:d.hosts}),bridgePath:path.resolve('electron/mcp/bridge.cjs')});await setup.create({name:'Headless fixture'});const id=setup.state.clients[0].id;await setup.update(id,{hostIds:['one'],rights:['hosts','connect']});await setup.setEnabled(true);await setup.close();
 try{
  let prompted=false;runtime=await startHeadless(dir,async()=>{prompted=true;return password});assert(prompted);assert.equal(runtime.access.headless,true);assert.throws(()=>acquireRuntime(dir),/already running/);
  client=new Client({name:'headless-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('electron/mcp/bridge.cjs'),'--credential',setup.credentialPath(id)]}));
  const hosts=await client.callTool({name:'harbor_list_hosts',arguments:{}});assert(!hosts.isError);
  assert((await client.callTool({name:'harbor_connect',arguments:{hostId:'one'}})).isError);assert.equal(runtime.access.pending.size,0);
 }finally{await client?.close();await runtime?.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('headless executes only approved exact commands against a verified SSH host',{timeout:15000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-headless-')),password='Harbor-headless-fixture';let runtime,client;
 const root=path.join(dir,'remote');await fs.mkdir(root);const remote=await require('./helpers/mcp-server.cjs').createMcpServer(root);
 const vault=new Vault(path.join(dir,'vault.hbr'));await vault.create(password);const d=await vault.read();d.hosts.push(remote.host);d.knownHosts[`127.0.0.1:${remote.host.port}`]=remote.fingerprint;await vault.save(d);vault.lock();
 const setup=new McpAccess({dir,readVault:async()=>({hosts:d.hosts}),bridgePath:path.resolve('electron/mcp/bridge.cjs')});await setup.create({name:'Headless SSH fixture'});const id=setup.state.clients[0].id;await setup.update(id,{hostIds:['fixture'],rights:['connect','exec']});setup.ssh=new McpSsh({resolve:async hostId=>resolveConnection(d,hostId)});await setup.saveRules(id,[{tool:'harbor_connect',hostId:'fixture'},{tool:'harbor_exec',hostId:'fixture',command:'fixture-command'}],true);await setup.setEnabled(true);await setup.close();
 try{
  runtime=await startHeadless(dir,async()=>password);client=new Client({name:'headless-ssh-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('electron/mcp/bridge.cjs'),'--credential',setup.credentialPath(id)]}));
  const response=await client.callTool({name:'harbor_connect',arguments:{hostId:'fixture'}});assert(!response.isError);const {sessionId}=JSON.parse(response.content[0].text);
  const exec=await client.callTool({name:'harbor_exec',arguments:{sessionId,command:'fixture-command'}});assert(!exec.isError);assert.equal(JSON.parse(exec.content[0].text).stdout,'HARBOR_MCP_OK');
  assert((await client.callTool({name:'harbor_exec',arguments:{sessionId,command:'fixture-command; id'}})).isError);assert.deepEqual(remote.commands,['fixture-command']);assert.equal(runtime.access.pending.size,0);
 }finally{await client?.close();await runtime?.close();await remote.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('headless scopes validate exact, folder, any-path and write rules without widening GUI grants',()=>{
 const c={hostIds:['one'],rights:['exec','files:list','files:read','files:write']},binding='b'.repeat(64),destination='test@host:22';
 const rule=(tool,fields)=>({tool,hostId:'one',binding,destination,...fields});
 for(const tool of ['harbor_list_files','harbor_read_file','harbor_write_file']){
  const folder=rule(tool,{scope:'directory',path:'/work'}),any=rule(tool,{scope:'all-paths'}),exact=rule(tool,{path:'/work/file'});
  for(const grant of [folder,any,exact]){
   assert.equal(rules(c,[grant],{headless:true}).length,1);
   assert.throws(()=>rules(c,[grant],{allowAllCommands:true}));
   assert(!matches({...c,automations:[grant]},tool,'one',{path:'/work/file'},'a'.repeat(64)));
   assert(!matches({...c,automations:[grant]},tool,'other',{path:'/work/file'},binding));
  }
  for(const candidate of ['/work','/work/nested/file','/work/sub/'])assert(matches({...c,automations:[folder]},tool,'one',{path:candidate},binding));
  for(const candidate of ['/worker/file','/else/file','/work/../secret','/work//file','relative','/work/./file'])assert(!matches({...c,automations:[folder]},tool,'one',{path:candidate},binding));
  assert(matches({...c,automations:[any]},tool,'one',{path:'/else/file'},binding));
  assert(!matches({...c,automations:[any]},tool,'one',{path:'/a/../secret'},binding));
  assert(!matches({...c,automations:[exact]},tool,'one',{path:'/work/file2'},binding));
  assert(!matches({...c,automations:[{tool,hostId:'one',scope:'all-paths'}]},tool,'one',{path:'/work/file'},binding));
 }
 const command=rule('harbor_exec',{scope:'all-commands'});assert(matches({...c,automations:[command]},'harbor_exec','one',{command:'anything; id'},binding));
 for(const bad of [rule('harbor_exec',{scope:'directory',path:'/work'}),rule('harbor_exec',{scope:'all-commands',command:'id'}),rule('harbor_read_file',{scope:'all-paths',path:'/work'}),rule('harbor_read_file',{scope:'directory',path:'/work/'}),rule('harbor_read_file',{scope:'directory',path:'/work/../'}),rule('harbor_write_file',{path:'/work/file',content:'not a rule'}),{...command,binding:'bad'},{...command,hostId:'other'}])assert.throws(()=>rules(c,[bad],{headless:true}));
 assert(matches({...c,automations:[rule('harbor_read_file',{scope:'directory',path:'/'})]},'harbor_read_file','one',{path:'/any/file'},binding));
 assert.throws(()=>rules({...c,rights:['files:read']},[rule('harbor_write_file',{scope:'all-paths'})],{headless:true}));
});

test('headless broad scopes run real SSH and SFTP with bound accounts and leave GUI approval required',{timeout:25000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-headless-scopes-')),password='Harbor-headless-fixture';let runtime,client;
 const root=path.join(dir,'remote');await fs.mkdir(path.join(root,'work'),{recursive:true});await fs.mkdir(path.join(root,'else'));await fs.writeFile(path.join(root,'work','read.txt'),'WORK');await fs.writeFile(path.join(root,'else','read.txt'),'ELSE');
 const remote=await require('./helpers/mcp-server.cjs').createMcpServer(root),vault=new Vault(path.join(dir,'vault.hbr'));await vault.create(password);const d=await vault.read();d.hosts.push(remote.host);d.knownHosts[`127.0.0.1:${remote.host.port}`]=remote.fingerprint;await vault.save(d);vault.lock();
 const setup=new McpAccess({dir,readVault:async()=>({hosts:d.hosts}),bridgePath:path.resolve('electron/mcp/bridge.cjs')});
 try{
  await setup.create({name:'Broad headless fixture'});const id=setup.state.clients[0].id;await setup.update(id,{hostIds:['fixture'],rights:['connect','exec','files:list','files:read','files:write']});setup.ssh=new McpSsh({resolve:async hostId=>resolveConnection(d,hostId)});
  const preview=await setup.previewApproval(id,'fixture'),grant=(tool,fields={})=>({tool,hostId:'fixture',binding:preview.binding,destination:'ignored client text',...fields});
  await assert.rejects(setup.saveRules(id,[{tool:'harbor_exec',hostId:'fixture',scope:'all-commands'}],true),/Review/);
  await assert.rejects(setup.saveRules(id,[grant('harbor_exec',{scope:'all-commands'})],false),/Confirm/);
  const grants=[grant('harbor_connect'),grant('harbor_exec',{scope:'all-commands'}),grant('harbor_list_files',{scope:'directory',path:'/work'}),grant('harbor_read_file',{scope:'all-paths'}),grant('harbor_write_file',{scope:'directory',path:'/work'})];
  await setup.saveRules(id,grants,true);assert(setup.state.clients[0].automations.every(r=>r.destination.startsWith('test@127.0.0.1:')));
  // A changed public account/destination never inherits a previously reviewed rule.
  d.hosts[0].username='changed';await assert.rejects(setup.saveRules(id,grants,true),/SSH target changed/);
  await setup.saveRules(id,setup.state.clients[0].automations.slice(1),true);assert.equal(setup.state.clients[0].automations.length,4);d.hosts[0].username='test';await setup.saveRules(id,grants,true);
  await setup.setEnabled(true);
  const peer={client:setup.state.clients[0],connectionId:'gui-fixture',socket:{destroyed:false}};const pending=setup.approve(peer,'harbor_read_file',{path:'/work/read.txt'},await setup.ssh.describe('fixture'));assert.equal(setup.pending.size,1);setup.answer([...setup.pending.keys()][0],false);await assert.rejects(pending,{code:"REQUEST_DENIED"});
  await setup.close();runtime=await startHeadless(dir,async()=>password);
  assert.equal(runtime.access.state.clients[0].automations.length,5);assert.equal(runtime.access.error,'');
  client=new Client({name:'scopes-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('electron/mcp/bridge.cjs'),'--credential',setup.credentialPath(id)]}));
  const call=async(name,args)=>client.callTool({name,arguments:args}),connected=await call('harbor_connect',{hostId:'fixture'});assert(!connected.isError);const {sessionId}=JSON.parse(connected.content[0].text);
  assert(!(await call('harbor_exec',{sessionId,command:'different-command; id'})).isError);
  assert(!(await call('harbor_list_files',{sessionId,path:'/work'})).isError);assert((await call('harbor_list_files',{sessionId,path:'/else'})).isError);
  assert.equal(JSON.parse((await call('harbor_read_file',{sessionId,path:'/else/read.txt'})).content[0].text).content,'ELSE');
  assert(!(await call('harbor_write_file',{sessionId,path:'/work/new.txt',content:'CREATED'})).isError);assert.equal(await fs.readFile(path.join(root,'work/new.txt'),'utf8'),'CREATED');
  assert(!(await call('harbor_write_file',{sessionId,path:'/work/read.txt',content:'REPLACED'})).isError);assert.equal(await fs.readFile(path.join(root,'work/read.txt'),'utf8'),'REPLACED');
  assert((await call('harbor_write_file',{sessionId,path:'/else/read.txt',content:'DENIED'})).isError);assert.equal(await fs.readFile(path.join(root,'else/read.txt'),'utf8'),'ELSE');
  assert((await call('harbor_read_file',{sessionId,path:'/work/../else/read.txt'})).isError);assert.equal(runtime.access.pending.size,0);
  assert(!runtime.access.tools([...runtime.access.server.peers.values()][0]).some(t=>t.name.includes('clear')));
 }finally{await client?.close();await runtime?.close();await setup.close();await remote.close();await fs.rm(dir,{recursive:true,force:true})}
});
