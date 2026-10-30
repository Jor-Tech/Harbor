'use strict';
const {_electron:electron}=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js'),{createMcpServer}=require('../tests/helpers/mcp-server.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-approval-ux-'));let app,client,remote;
 try{
  const root=path.join(dir,'remote');await fs.mkdir(path.join(root,'root'),{recursive:true});await fs.writeFile(path.join(root,'root/review.txt'),'ORIGINAL');
  remote=await createMcpServer(root,{username:'root'});
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await app.evaluate(async({dialog,clipboard})=>{dialog.showMessageBox=async()=>({response:1});globalThis.approvalTestClipboard=await clipboard.read()});
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-approval-UX-password');await page.getByLabel('Confirm password',{exact:true}).fill('Harbor-approval-UX-password');await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await page.evaluate(host=>window.harbor.invoke('entity:save',{collection:'hosts',item:host}),remote.host);
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-approval-UX-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manage local MCP',exact:true}).click();await page.getByLabel('Client name',{exact:true}).fill('ChatGPT approval demo');await page.getByRole('button',{name:'Pair local client',exact:true}).click();await page.getByRole('heading',{name:'ChatGPT approval demo',exact:true}).waitFor();
  for(const label of ['MCP fixture','Open SSH connections','Run commands and share output','List remote folders','Read remote text files','Write remote text files'])await page.getByLabel(label,{exact:true}).check();
  await page.getByRole('button',{name:'Save permissions',exact:true}).click();await page.getByLabel('Enable local MCP',{exact:true}).click();await page.getByText('MCP active',{exact:true}).waitFor();
  const setup=(await page.evaluate(()=>window.harbor.invoke('mcp:status'))).clients[0].config.mcpServers.harbor;
  client=new Client({name:'approval-ux',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:setup.args}));
  const panel=page.locator('.mcp-request'),consent=()=>panel.getByLabel('I approve this action and sharing its result with this client.',{exact:true});
  async function request(name,args){const response=client.callTool({name,arguments:args},undefined,{timeout:330000});response.catch(()=>{});await page.getByRole('tab',{name:'Requests',exact:true}).click();await panel.waitFor();return {response}}
  const screenshot=async name=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:`research/harbor-approval-${name}.png`})};
  const checkWidth=async()=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const layout=await panel.evaluate(e=>({width:e.clientWidth,scrollWidth:e.scrollWidth,overflow:[...e.querySelectorAll('*')].filter(child=>child.getBoundingClientRect().right>e.getBoundingClientRect().right+1).map(child=>({tag:child.tagName,className:child.className,width:child.getBoundingClientRect().width,text:child.textContent.slice(0,80)}))}));assert(layout.scrollWidth<=layout.width+1,'Request must not overflow horizontally: '+JSON.stringify(layout));};
  const connect=await request('harbor_connect',{hostId:'fixture'});await consent().check();await panel.getByRole('button',{name:'Approve once',exact:true}).click();const connection=await connect.response;assert(!connection.isError);const {sessionId}=JSON.parse(connection.content[0].text);
  for(const [tool,args,title] of [['harbor_list_files',{path:'/root'},'List folder'],['harbor_read_file',{path:'/root/review.txt'},'Read file'],['harbor_exec',{command:'ls -ld -- /root'},'Run command'],['harbor_write_file',{path:'/root/review.txt',content:'Harbor approval test.\nThis content must only be written after approval.\n'},'Write file']]){
   const pending=await request(tool,{sessionId,...args});await panel.getByRole('heading',{name:title,exact:true}).waitFor();assert.equal(await panel.locator('.mcp-request-account.is-root').count(),1);assert(await panel.getByRole('button',{name:'Approve once',exact:true}).isDisabled());
   if(args.path){assert.equal(await panel.locator('.mcp-exact-path').textContent(),args.path);await panel.getByRole('button',{name:'Copy remote path',exact:true}).click();await panel.getByText('Path copied',{exact:true}).waitFor();assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),args.path)}
   if(tool==='harbor_write_file'){
    await panel.getByText('May replace an existing file',{exact:true}).waitFor();assert.equal(await panel.locator('.mcp-exact-content').textContent(),args.content);
   }
   for(const name of ['Allow for this session','Always allow…']){assert(await panel.getByRole('button',{name,exact:true}).isVisible());assert(await panel.getByRole('button',{name,exact:true}).isDisabled())}
   if(tool!=='harbor_list_files'){
    await page.setViewportSize({width:1440,height:1000});await page.locator('.page-content').evaluate(e=>e.scrollTo(0,0));await screenshot(tool+'-dark');await checkWidth();
    // Change only presentation locally; real approval and SSH paths remain untouched.
    await page.evaluate(()=>document.documentElement.dataset.theme='light');await screenshot(tool+'-light');
    await page.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();await checkWidth();await screenshot(tool+'-mobile');
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.setViewportSize({width:1440,height:1000});
   }
   await panel.getByRole('button',{name:'Deny request',exact:true}).click();assert((await pending.response).isError);await panel.waitFor({state:'hidden'});
  }
  assert.equal(await fs.readFile(path.join(root,'root/review.txt'),'utf8'),'ORIGINAL','Denied write must preserve original bytes');assert.deepEqual(remote.commands,[],'Denied command must never reach SSH');
  // Long paths remain exact and visible; empty writes explicitly explain clearing the file.
  const longPath='/root/'+('long folder name/'.repeat(14))+'file.txt';const empty=await request('harbor_write_file',{sessionId,path:longPath,content:''});await panel.getByText('Empty content — creates an empty file or clears an existing file.',{exact:true}).waitFor();await page.setViewportSize({width:390,height:844});await checkWidth();assert.equal(await panel.locator('.mcp-exact-path').textContent(),longPath);await panel.getByRole('button',{name:'Deny request',exact:true}).click();assert((await empty.response).isError);
  await page.setViewportSize({width:1440,height:1000});const allowed=await request('harbor_write_file',{sessionId,path:'/root/review.txt',content:'APPROVED'});await consent().check();await panel.getByRole('button',{name:'Approve once',exact:true}).click();assert(!(await allowed.response).isError);assert.equal(await fs.readFile(path.join(root,'root/review.txt'),'utf8'),'APPROVED');
  // Write grants are reviewed explicitly, scope consent resets, and future writes follow the chosen scope.
  await fs.mkdir(path.join(root,'root/sub'),{recursive:true});
  const writeConsent=()=>panel.getByLabel('I authorize future writes with any content in this scope and sharing their results.',{exact:true});
  for(const duration of ['session','always']){
   const file=duration==='session'?'/root/session.txt':'/root/saved.txt';
   const pending=await request('harbor_write_file',{sessionId,path:file,content:'FIRST'});await consent().check();
   await panel.getByRole('button',{name:duration==='session'?'Allow for this session':'Always allow…',exact:true}).click();
   const review=panel.getByRole('region',{name:'Review automatic write permission',exact:true});await review.waitFor();
   const scope=review.getByLabel('Write approval scope',{exact:true});assert.equal(await scope.inputValue(),'exact');assert(await scope.evaluate(e=>e===document.activeElement));
   const confirm=review.getByRole('button',{name:duration==='session'?'Allow scope for this session':'Save scope and approve',exact:true});assert(await confirm.isDisabled());
   await writeConsent().check();await scope.selectOption('directory');assert(!(await writeConsent().isChecked()));assert(await confirm.isDisabled());
   if(duration==='session')await scope.selectOption('exact');
   await writeConsent().check();await review.scrollIntoViewIfNeeded();await screenshot('write-scope-'+duration+'-dark');
   await page.setViewportSize({width:390,height:844});await checkWidth();await review.screenshot({path:`research/harbor-approval-write-scope-${duration}-mobile.png`});const largerLabels=await page.addStyleTag({content:'.mcp-request .mcp-remember .mcp-actions>.button{font-size:16px}'});await checkWidth();await largerLabels.evaluate(e=>e.remove());await page.setViewportSize({width:1440,height:1000});
   await review.getByRole('button',{name:'Cancel permission',exact:true}).click();assert.equal((await page.evaluate(()=>window.harbor.invoke('mcp:status'))).pending.length,1);
   assert(await panel.getByRole('button',{name:duration==='session'?'Allow for this session':'Always allow…',exact:true}).evaluate(e=>e===document.activeElement));
   await panel.getByRole('button',{name:duration==='session'?'Allow for this session':'Always allow…',exact:true}).click();if(duration==='always')await panel.getByLabel('Write approval scope',{exact:true}).selectOption('directory');await writeConsent().check();await confirm.click();assert(!(await pending.response).isError);assert.equal(await fs.readFile(path.join(root,file),'utf8'),'FIRST');
   const target=duration==='session'?file:'/root/sub/automatic.txt';const result=await client.callTool({name:'harbor_write_file',arguments:{sessionId,path:target,content:'SECOND'}});assert(!result.isError);assert.equal(await fs.readFile(path.join(root,target),'utf8'),'SECOND');
   const outside=await request('harbor_write_file',{sessionId,path:duration==='session'?'/root/unapproved.txt':'/outside.txt',content:'DENIED'});await panel.getByRole('button',{name:'Deny request',exact:true}).click();assert((await outside.response).isError);
  }
  assert.deepEqual(errors,[]);console.log('PASS: action-specific approval cards, privileged account, exact copyable paths/content, empty-write warning, dark/light/mobile, visible duration choices, explicit write scope consent, cancellation, temporary exact writes, saved folder writes, out-of-scope denial and one-time write.');
 }finally{await client?.close();if(app)await app.evaluate(async({clipboard})=>{if(globalThis.approvalTestClipboard)await clipboard.write(globalThis.approvalTestClipboard)}).catch(()=>{});await app?.close();await remote?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
