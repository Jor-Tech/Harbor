'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {McpAccess}=require('../electron/mcp/access.cjs'),{McpSsh}=require('../electron/mcp/ssh.cjs'),{RIGHTS}=require('../electron/mcp/policy.cjs'),{createMcpServer}=require('./helpers/mcp-server.cjs');
test('real MCP -> private socket -> SSH exec and SFTP with approval and bounded output',{timeout:30000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-')),root=path.join(dir,'remote');await fs.mkdir(root);await fs.writeFile(path.join(root,'sample.txt'),'fixture file');
 const remote=await createMcpServer(root),bridgePath=path.resolve('electron/mcp/bridge.cjs');let client,acceptHost=true;
 const a=new McpAccess({dir,bridgePath,readVault:async()=>({hosts:[remote.host]})});
 a.ssh=new McpSsh({resolve:async()=>({host:remote.host,credential:{username:'test',password:'fixture-password'},route:[]}),verifyHost:async()=>acceptHost});
 a.ssh.onClosed=id=>a.sessions.delete(id);
 const wait=async()=>{for(let i=0;i<200&&!a.pending.size;i++)await new Promise(r=>setTimeout(r,5));assert.equal(a.pending.size,1);return [...a.pending.keys()][0]};
 const call=async(name,args,approved=true)=>{const p=client.callTool({name,arguments:args});a.answer(await wait(),approved,true);return p};
 const value=result=>{assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text)};
 try{
  await a.create({name:'SSH fixture client'});const id=a.state.clients[0].id;await a.update(id,{hostIds:['fixture'],rights:RIGHTS});await a.setEnabled(true);
  client=new Client({name:'fixture-client',version:'1.0'});await client.connect(new StdioClientTransport({command:process.execPath,args:[bridgePath,'--credential',a.credentialPath(id)]}));
  assert.equal((await call('harbor_connect',{hostId:'fixture'},false)).structuredContent.error.code,'REQUEST_DENIED');assert.equal(remote.clients.size,0);
  acceptHost=false;assert.equal((await call('harbor_connect',{hostId:'fixture'})).structuredContent.error.code,'APPROVED_ACTION_FAILED');acceptHost=true;
  const {sessionId}=value(await call('harbor_connect',{hostId:'fixture'}));
  const exec=value(await call('harbor_exec',{sessionId,command:'fixture-command'}));assert.equal(exec.stdout,'HARBOR_MCP_OK');assert.equal(exec.stderr,'fixture warning');assert.equal(exec.exitCode,23);assert(exec.untrustedContent);
  assert.equal(value(await call('harbor_read_file',{sessionId,path:'/sample.txt'})).content,'fixture file');
  assert(value(await call('harbor_list_files',{sessionId,path:'/'})).entries.some(e=>e.name==='sample.txt'));
  assert(value(await call('harbor_write_file',{sessionId,path:'/written.txt',content:'written by fixture'})).written);assert.equal(await fs.readFile(path.join(root,'written.txt'),'utf8'),'written by fixture');
  assert(value(await call('harbor_write_file',{sessionId,path:'/written.txt',content:'replacement'})).written);assert.equal(await fs.readFile(path.join(root,'written.txt'),'utf8'),'replacement');
  assert.equal((await call('harbor_exec',{sessionId,command:'fixture-big'})).isError,true);
  assert.equal(a.sessions.size,0);assert.equal(JSON.stringify(a.snapshot().audit).includes('fixture-command'),false);
 }finally{await client?.close();await a.close();await remote.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('fast commands preserve close-event exit status and signals when exit precedes the await continuation',async()=>{
 const {EventEmitter}=require('node:events');
 for(const [code,signal] of [[23,undefined],[null,'SIGTERM'],[undefined,undefined]]){
  const ssh=new McpSsh({resolve:async()=>{}}),stream=new EventEmitter();stream.stderr=new EventEmitter();stream.destroy=()=>{};
  const session={client:{exec(command,done){
   done(null,stream);
   // ssh2 can parse command acceptance and exit in one incoming packet.
   stream.emit('exit',code,signal);
   setImmediate(()=>{stream.emit('data',Buffer.from('output'));stream.stderr.emit('data',Buffer.from('error output'));stream.emit('close',code,signal)});
  }}};
  ssh.manager._session=()=>session;
  const result=await ssh.exec('session','fast command',()=>{});
  assert.equal(result.exitCode,code??null);assert.equal(result.signal,signal??null);assert.equal(result.stdout,'output');assert.equal(result.stderr,'error output');
 }
});


test('SFTP replacement uses the OpenSSH extension, preserves existing bytes on failure and safely supports new files without it',{timeout:30000},async()=>{
 for(const config of [{posixRename:true},{posixRename:false},{posixRename:true,renameFailure:3}]){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-atomic-write-')),control={...config,operations:[]};
  const remote=await createMcpServer(root,{sftpControl:control});
  const ssh=new McpSsh({resolve:async()=>({host:remote.host,credential:{username:'test',password:'fixture-password'},route:[]}),verifyHost:async()=>true});
  try{
   await fs.writeFile(path.join(root,'existing.txt'),'KEEP');const description=await ssh.describe('fixture');await ssh.connect('fixture',description.digest,()=>{},'test-session');
   const write=(target,content)=>ssh.write('test-session',target,content,()=>{});
   if(config.renameFailure){await assert.rejects(write('/existing.txt','REPLACE'));assert(!control.operations.some(o=>o.operation==='rename'));}
   else if(config.posixRename===false){await assert.rejects(write('/existing.txt','REPLACE'),{code:'ATOMIC_REPLACE_UNSUPPORTED'});await write('/new.txt','NEW');assert.equal(await fs.readFile(path.join(root,'new.txt'),'utf8'),'NEW');}
   else{await write('/existing.txt','REPLACE');await write('/new.txt','NEW');assert(control.operations.every(o=>o.operation==='posix-rename'));}
   assert.equal(await fs.readFile(path.join(root,'existing.txt'),'utf8'),config.posixRename&&!config.renameFailure?'REPLACE':'KEEP');
   assert(!(await fs.readdir(root)).some(name=>name.startsWith('.harbor-mcp-')),'Temporary files must be removed on success and failure');
   let checks=0;await assert.rejects(ssh.write('test-session','/existing.txt','CANCELLED',()=>{if(++checks===2)throw new Error('revoked')}),/revoked/);
   assert.equal(await fs.readFile(path.join(root,'existing.txt'),'utf8'),config.posixRename&&!config.renameFailure?'REPLACE':'KEEP');
   assert(!(await fs.readdir(root)).some(name=>name.startsWith('.harbor-mcp-')));
  }finally{ssh.closeAll();await remote.close();await fs.rm(root,{recursive:true,force:true})}
 }
});
