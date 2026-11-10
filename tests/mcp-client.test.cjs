'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {McpAccess}=require('../electron/mcp/access.cjs');
test('the same stdio client survives vault lock but stays blocked until explicit resume', {timeout:15000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-resume-')),bridgePath=path.resolve('electron/mcp/bridge.cjs');let client,locked=false;
 const access=new McpAccess({dir,bridgePath,readVault:async()=>{if(locked)throw new Error('Locked');return {hosts:[{id:'one',label:'Allowed'}]}}});
 try{
  await access.create({name:'Resume fixture'});const id=access.state.clients[0].id;
  await access.update(id,{hostIds:['one'],rights:['hosts']});await access.setEnabled(true);
  client=new Client({name:'resume-client',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[bridgePath,'--credential',access.credentialPath(id)]});await client.connect(transport);
  const pid=transport.pid,connectionId=[...access.server.peers.keys()][0];let closed=false;client.onclose=()=>{closed=true};
  const hosts=()=>client.callTool({name:'harbor_list_hosts',arguments:{}});
  assert.equal((await hosts()).isError,false);
  for(let i=0;i<2;i++){
   access.sessionApprovals.set('temporary',{clientId:id,connectionId});access.sessions.set('old-session',{clientId:id,connectionId});
   locked=true;access.pause({keepClients:true});
   await assert.rejects(client.listTools());await assert.rejects(hosts());await assert.rejects(access.resume());
   assert.equal(access.sessions.size,0);assert.equal(access.sessionApprovals.size,0);
   locked=false;await assert.rejects(hosts());assert.equal(access.active,false);
   await access.resume();assert.equal((await hosts()).isError,false);
   assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['harbor_list_hosts']);
   assert.equal(closed,false);assert.equal(transport.pid,pid);assert.equal([...access.server.peers.keys()][0],connectionId);
  }
  // Revocation must still terminate the transport, including after a vault lock.
  const disconnected=new Promise(resolve=>{client.onclose=resolve});await access.revoke(id);await disconnected;
  await access.resume();await assert.rejects(hosts());
 }finally{await client?.close();await access.close();await fs.rm(dir,{recursive:true,force:true})}
});
test('official MCP client discovers and calls tools via the real stdio bridge with host isolation',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-')),bridgePath=path.resolve('electron/mcp/bridge.cjs');let client;
 const access=new McpAccess({dir,bridgePath,readVault:async()=>({hosts:[{id:'allowed',label:'Allowed',address:'test.invalid',password:'DO_NOT_EXPOSE',privateKey:'PRIVATE'},{id:'hidden',label:'Hidden'}],keys:[{privateKey:'PRIVATE'}]})});
 try{
  await access.load();await access.create({name:'SDK fixture'});const id=access.state.clients[0].id;
  await access.update(id,{hostIds:['allowed'],rights:['hosts']});await access.setEnabled(true);
  client=new Client({name:'test-client',version:'1.0.0'});await client.connect(new StdioClientTransport({command:process.execPath,args:[bridgePath,'--credential',access.credentialPath(id)]}));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['harbor_list_hosts']);
  const response=await client.callTool({name:'harbor_list_hosts',arguments:{}});assert(!response.isError);assert.deepEqual(JSON.parse(response.content[0].text).hosts.map(h=>h.id),['allowed']);assert(!JSON.stringify(response).includes('DO_NOT_EXPOSE'));assert(!JSON.stringify(response).includes('PRIVATE'));
  assert.equal((await client.callTool({name:'harbor_list_hosts',arguments:{action:'vault:read'}})).isError,true);
  assert.equal((await client.callTool({name:'harbor_list_sessions',arguments:{}})).isError,true);
  const original=JSON.parse(await fs.readFile(access.credentialPath(id),'utf8'));
  const other=await require('../electron/mcp/identity.cjs').identity(path.join(dir,'other-identity'));
  for(const tampered of [{...original,token:'0'.repeat(64)},{...original,serverCertificate:other.cert}]){
   const file=path.join(dir,'invalid-client.json');await fs.writeFile(file,JSON.stringify(tampered),{mode:0o600});const bad=new Client({name:'invalid-client',version:'1'});
   try{await assert.rejects(bad.connect(new StdioClientTransport({command:process.execPath,args:[bridgePath,'--credential',file],stderr:'pipe'})));}finally{await bad.close();}
  }
  const consoleOutput=await new Promise((resolve,reject)=>{const child=require('node:child_process').spawn(process.execPath,[path.resolve('scripts/mcp-console.cjs'),'--credential',access.credentialPath(id)],{stdio:['pipe','pipe','pipe']});let output='',errors='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(new Error('Review console failed: '+errors)));child.stdin.end('hosts\nquit\n');});
  assert(consoleOutput.includes('Allowed'));assert(!consoleOutput.includes('DO_NOT_EXPOSE'));
 }finally{await client?.close();await access.close();await fs.rm(dir,{recursive:true,force:true})}
});
