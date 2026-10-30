'use strict';
const {_electron:electron}=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js'),{createMcpServer}=require('../tests/helpers/mcp-server.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-approval-matrix-'));let app,page,client,remote;
 const password='Harbor-approval-matrix-password',errors=[];
 const launch=async()=>{app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})})};
 const state=()=>page.evaluate(()=>window.harbor.invoke('mcp:status'));
 const panel=()=>page.locator('.mcp-request');
 const invoke=(name,args)=>{const result=client.callTool({name,arguments:args},undefined,{timeout:45000});result.catch(()=>{});return result};
 const value=result=>{assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text)};
 async function review(name,args,duration){
  const result=invoke(name,args);await page.getByRole('tab',{name:'Requests',exact:true}).click();await panel().waitFor();
  if(duration==='deny')await panel().getByRole('button',{name:'Deny request',exact:true}).click();
  else{
   await panel().getByLabel('I approve this action and sharing its result with this client.',{exact:true}).check();
   await panel().getByRole('button',{name:duration==='session'?'Allow for this session':duration==='always'?'Always allow…':'Approve once',exact:true}).click();
   if(name==='harbor_write_file'&&duration!=='once'){
    assert.equal(await panel().getByLabel('Write approval scope',{exact:true}).inputValue(),'exact');
    await panel().getByLabel('I authorize future writes with any content in this scope and sharing their results.',{exact:true}).check();
    await panel().getByRole('button',{name:duration==='session'?'Allow scope for this session':'Save scope and approve',exact:true}).click();
   }else if(duration==='always')await panel().getByRole('button',{name:'Save permission and approve',exact:true}).click();
  }
  const response=await result;await panel().waitFor({state:'hidden'});
  if(duration==='deny'){assert.equal(response.structuredContent?.error.code,'REQUEST_DENIED');return response}
  return value(response);
 }
 async function automatic(name,args,duration){
  const before=(await state()).audit.filter(r=>r.status==='requested').length;
  const result=invoke(name,args);
  // Race against a prompt so a regression fails immediately instead of waiting for expiry.
  const outcome=await Promise.race([result.then(response=>({response})),panel().waitFor().then(()=>({prompt:true}))]);
  assert(!outcome.prompt,`${name} unexpectedly requested approval (${duration})`);
  const parsed=value(outcome.response),current=await state();assert.equal(current.pending.length,0);assert.equal(current.audit.filter(r=>r.status==='requested').length,before);
  assert.equal(current.audit.filter(r=>r.tool===name&&r.status==='approved').at(-1).approval,duration==='always'?'saved':'session');return parsed;
 }
 async function pair(setup){client=new Client({name:'approval-matrix',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:setup.args}))}
 const calls=(sessionId,duration)=>[
  ['harbor_list_files',{sessionId,path:'/work'}],
  ['harbor_read_file',{sessionId,path:'/read.txt'}],
  ['harbor_exec',{sessionId,command:'fixture-'+duration}],
  ['harbor_write_file',{sessionId,path:'/work/write-'+duration+'.txt',content:'FIRST'}]
 ];
 try{
  const root=path.join(dir,'remote');await fs.mkdir(path.join(root,'work'),{recursive:true});await fs.mkdir(path.join(root,'other'));await fs.writeFile(path.join(root,'read.txt'),'READ');await fs.writeFile(path.join(root,'other.txt'),'OTHER');remote=await createMcpServer(root);
  await launch();await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await page.evaluate(host=>window.harbor.invoke('entity:save',{collection:'hosts',item:host}),remote.host);
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manage local MCP',exact:true}).click();
  for(const duration of ['session','always']){
   await page.getByRole('tab',{name:'Clients',exact:true}).click();await page.getByLabel('Client name',{exact:true}).fill('Matrix '+duration);await page.getByRole('button',{name:'Pair local client',exact:true}).click();await page.getByRole('heading',{name:'Matrix '+duration,exact:true}).waitFor();
   for(const label of ['MCP fixture','List permitted hosts','List own connections','Open SSH connections','Run commands and share output','List remote folders','Read remote text files','Write remote text files','Close own connections'])await page.getByLabel(label,{exact:true}).check();
   await page.getByRole('button',{name:'Save permissions',exact:true}).click();if(!(await state()).enabled)await page.getByLabel('Enable local MCP',{exact:true}).click();else await page.getByRole('button',{name:'Resume MCP access',exact:true}).click();await page.getByText('MCP active',{exact:true}).waitFor();
   const paired=(await state()).clients.find(c=>c.name==='Matrix '+duration),setup=paired.config.mcpServers.harbor;await pair(setup);
   assert.equal(value(await invoke('harbor_list_hosts',{})).hosts.length,1);assert.equal(value(await invoke('harbor_list_sessions',{})).sessions.length,0);assert.equal((await state()).pending.length,0);
   const first=await review('harbor_connect',{hostId:'fixture'},duration),second=await automatic('harbor_connect',{hostId:'fixture'},duration);
   for(const [tool,args] of calls(first.sessionId,duration)){
    await review(tool,args,duration);const secondArgs={...args,sessionId:second.sessionId,...(tool==='harbor_write_file'?{content:'REPLACED'}:{})};const result=await automatic(tool,secondArgs,duration);
    if(tool==='harbor_read_file')assert.equal(result.content,'READ');if(tool==='harbor_exec')assert.equal(result.stdout,'HARBOR_MCP_OK');if(tool==='harbor_write_file')assert.equal(await fs.readFile(path.join(root,args.path),'utf8'),'REPLACED');
   }
   for(const [tool,args] of [['harbor_list_files',{path:'/other'}],['harbor_read_file',{path:'/other.txt'}],['harbor_exec',{command:'outside-'+duration}],['harbor_write_file',{path:'/outside.txt',content:'DENIED'}]])await review(tool,{sessionId:first.sessionId,...args},'deny');
   assert(!remote.commands.includes('outside-'+duration));await assert.rejects(fs.access(path.join(root,'outside.txt')),{code:'ENOENT'});
   // Approved execution failures must be distinguishable from an actual denial.
   const failed=invoke('harbor_read_file',{sessionId:first.sessionId,path:'/missing.txt'});await panel().waitFor();await panel().getByLabel('I approve this action and sharing its result with this client.',{exact:true}).check();await panel().getByRole('button',{name:'Approve once',exact:true}).click();assert.equal((await failed).structuredContent?.error.code,'APPROVED_ACTION_FAILED');await panel().waitFor({state:'hidden'});
   await review('harbor_disconnect',{sessionId:first.sessionId},duration);await automatic('harbor_disconnect',{sessionId:second.sessionId},duration);
   const before=await state();assert.equal((duration==='session'?before.temporaryApprovals:before.clients.find(c=>c.id===paired.id).approvals).length,6);
   await page.getByRole('tab',{name:'Activity',exact:true}).click();await page.getByText('Approved, but execution failed',{exact:true}).last().scrollIntoViewIfNeeded();await page.screenshot({path:`research/harbor-approval-matrix-${duration}-activity.png`});
   await client.close();client=null;await page.waitForFunction(async()=>(await window.harbor.invoke('mcp:status')).temporaryApprovals.length===0);
   if(duration==='always'){
    await app.close();app=null;await launch();await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manage local MCP',exact:true}).click();await page.getByRole('heading',{name:'Local MCP access',exact:true}).waitFor();assert.equal((await state()).active,false);await page.getByRole('button',{name:'Resume MCP access',exact:true}).click();await page.getByText('MCP active',{exact:true}).waitFor();
   }
   await pair(setup);await page.getByRole('tab',{name:'Requests',exact:true}).click();
   let next;
   if(duration==='session'){await review('harbor_connect',{hostId:'fixture'},'deny');next=await review('harbor_connect',{hostId:'fixture'},'once');}
   else next=await automatic('harbor_connect',{hostId:'fixture'},duration);
   for(const [tool,args] of calls(next.sessionId,duration)){
    if(duration==='session')await review(tool,args,'deny');else await automatic(tool,{...args,...(tool==='harbor_write_file'?{content:'AFTER RESTART'}:{})},duration);
   }
   if(duration==='session'){await review('harbor_disconnect',{sessionId:next.sessionId},'deny');await review('harbor_disconnect',{sessionId:next.sessionId},'once');}
   else{await automatic('harbor_disconnect',{sessionId:next.sessionId},duration);assert.equal(await fs.readFile(path.join(root,'work/write-always.txt'),'utf8'),'AFTER RESTART');}
   await client.close();client=null;console.log(`PASS ${duration}: all six approval actions, reuse across SSH sessions, scope boundaries, ${duration==='session'?'expiry on client disconnect':'persistence after app restart'}, metadata tools and distinct failure reasons.`);
  }
  assert.deepEqual(errors,[]);
 }finally{await client?.close();await app?.close();await remote?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
