'use strict';
const {_electron:electron}=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js'),{createMcpServer}=require('../tests/helpers/mcp-server.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-mcp-ui-'));let app,client,remote;
 try{
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  const page=await app.firstWindow();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-MCP-test-password');await page.getByLabel('Confirm password',{exact:true}).fill('Harbor-MCP-test-password');await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  const root=path.join(dir,'remote');await fs.mkdir(root);remote=await createMcpServer(root);
  await page.evaluate(host=>window.harbor.invoke('entity:save',{collection:'hosts',item:host}),remote.host);
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-MCP-test-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manage local MCP',exact:true}).click();await page.getByRole('heading',{name:'Local MCP access',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Enable local MCP',{exact:true}).isChecked(),false);
  await page.getByLabel('Client name',{exact:true}).fill('UAT client');await page.getByRole('button',{name:'Pair local client',exact:true}).click();await page.getByRole('heading',{name:'UAT client',exact:true}).waitFor();
  await page.getByLabel('MCP fixture',{exact:true}).check();await page.getByLabel('Open SSH connections',{exact:true}).check();await page.getByLabel('Run commands and share output',{exact:true}).check();await page.getByRole('button',{name:'Save permissions',exact:true}).click();
  await page.getByLabel('Enable local MCP',{exact:true}).click();await page.getByText('MCP active',{exact:true}).waitFor();
  const setup=(await page.evaluate(()=>window.harbor.invoke('mcp:status'))).clients[0].config.mcpServers.harbor;
  client=new Client({name:'desktop-fixture',version:'1.0'});await client.connect(new StdioClientTransport({command:process.execPath,args:setup.args}));
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})});
  async function approved(name,args){const response=client.callTool({name,arguments:args});await page.getByRole('tab',{name:'Requests',exact:true}).click();await page.locator('.mcp-request').waitFor();await page.getByLabel('I approve this action and sharing its result with this client.',{exact:true}).check();await page.getByRole('button',{name:'Approve once',exact:true}).click();const result=await response;assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);}
  const {sessionId}=await approved('harbor_connect',{hostId:'fixture'});const result=await approved('harbor_exec',{sessionId,command:'fixture-command'});assert.equal(result.stdout,'HARBOR_MCP_OK');
  await page.screenshot({path:'research/harbor-mcp-settings.png'});await client.close();client=null;
  await page.getByRole('tab',{name:'Clients',exact:true}).click();await page.getByRole('tab',{name:'Headless (Experimental)',exact:true}).click();await page.getByLabel('Headless host',{exact:true}).selectOption('fixture');await page.getByLabel('I authorize this unattended action and sharing its results.',{exact:true}).check();await page.getByRole('button',{name:'Add headless rule',exact:true}).click();
  await page.waitForFunction(async()=>(await window.harbor.invoke('mcp:status')).clients[0].automations?.length===1);await page.getByRole('button',{name:'Resume MCP access',exact:true}).click();await page.getByText('MCP active',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Service',exact:true}).click();const background=page.getByLabel('Keep Harbor in the system tray when closing the window',{exact:true});await background.click();
  await page.waitForFunction(async()=>(await window.harbor.invoke('mcp:status')).background);
  await page.evaluate(()=>window.harbor.invoke('window:close'));assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  assert.equal((await page.evaluate(()=>window.harbor.invoke('vault:status'))).locked,false);
  await app.evaluate(({app})=>app.emit('activate'));assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-MCP-test-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Local MCP access',exact:true}).waitFor();
  await page.getByText(/MCP paused/).first().waitFor();const state=await page.evaluate(()=>window.harbor.invoke('mcp:status'));assert.equal(state.active,false);assert.equal(state.clients.length,1);
  await page.getByRole('tab',{name:'Service',exact:true}).click();await background.click();assert.deepEqual(errors,[]);console.log('PASS: real MCP/SSH client approval UI, command output, MCP default off, pairing UI, enabling, tray background lifecycle, lock revocation and explicit resume.');
 }finally{await client?.close();await app?.close();await remote?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
