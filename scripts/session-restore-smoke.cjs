'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createTerminalServer}=require('../tests/helpers/terminal-server.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-restore-ui-')),server=await createTerminalServer();let app;
 try{
  const launch=()=>electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  app=await launch();let page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-restore-test-password');await page.getByLabel('Confirm password',{exact:true}).fill('Harbor-restore-test-password');await page.getByRole('button',{name:'Create vault',exact:true}).click();
  await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})});
  await page.getByRole('button',{name:'New host',exact:true}).click();
  await page.getByLabel('Label',{exact:true}).fill(server.host.label);await page.getByLabel('Address',{exact:true}).fill(server.host.address);await page.getByLabel('Port',{exact:true}).fill(String(server.host.port));await page.getByLabel('Username',{exact:true}).fill('test');await page.getByLabel('Account password',{exact:true}).fill('test-password');
  const preference=page.getByLabel('Keep remote sessions running with tmux');assert.equal(await preference.isChecked(),false);await preference.check();await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.locator('.host-card').getByRole('button',{name:'Connect',exact:true}).click();let pane=page.locator('.terminal-pane:visible');await pane.getByText('Connected',{exact:true}).waitFor();
  const first=[...server.state.persistent.keys()][0];assert(first);
  await pane.locator('.xterm-helper-textarea').fill('ONCE');
  // No saved workspace is needed to reconnect after locking this running app.
  await pane.getByLabel('Auto reconnect this tab').click();await pane.locator('.terminal-connection input:checked').waitFor();
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();
  assert.equal(await page.locator('.session-tab,.terminal-pane').count(),0);
  await assert.rejects(page.evaluate(()=>window.harbor.invoke('terminal:reconnect',{id:'locked-tab'})),/locked/i);
  const beforeUnlock=server.state.connections;
  await page.evaluate(()=>window.harbor.invoke('vault:lock'));
  await page.getByLabel('Vault password',{exact:true}).fill('incorrect-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.locator('.session-tab').count(),0);
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-restore-test-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await pane.getByRole('button',{name:'Reconnect',exact:true}).waitFor();
  assert.equal(server.state.connections,beforeUnlock);assert.equal(await pane.getByLabel('Auto reconnect this tab').isChecked(),false);
  assert.equal((await pane.locator('.xterm-rows').textContent()).trim(),'');
  server.state.otp=true;await pane.getByRole('button',{name:'Reconnect',exact:true}).click();
  await page.getByRole('heading',{name:'SSH verification',exact:true}).waitFor();await page.getByLabel('Verification code',{exact:true}).fill('123456');await page.getByRole('button',{name:'Continue',exact:true}).click();
  await pane.getByText('Connected',{exact:true}).waitFor();server.state.otp=false;
  assert.equal(server.state.persistent.size,1);assert.equal(server.state.persistent.get(first).input.join(''),'ONCE');

  await page.getByLabel('Terminal to add').selectOption({label:server.host.label});await page.getByRole('button',{name:'Split right',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.terminal-connection .connected').length===2);
  assert.equal(server.state.persistent.size,2);
  await page.getByRole('button',{name:'Save workspace',exact:true}).click();await page.getByLabel('Workspace name').fill('Persistent pair');await page.getByRole('button',{name:'Save layout',exact:true}).click();await page.getByLabel('Workspace name').waitFor({state:'hidden'});
  const saved=await page.evaluate(()=>window.harbor.invoke('vault:read'));assert.equal(saved.workspaces[0].layout.first.sessionRef,first);
  await page.locator('.terminal-pane:visible').first().getByRole('button',{name:'Disconnect',exact:true}).click();assert(server.state.persistent.has(first));
  await page.locator('.terminal-pane:visible').first().getByRole('button',{name:'Reconnect',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.terminal-connection .connected').length===2);assert.equal(server.state.persistent.size,2);
  await app.close();app=null;
  app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-restore-test-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await page.getByRole('button',{name:'Workspaces',exact:true}).click();await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.terminal-connection .connected').length===2);
  assert.equal(server.state.persistent.size,2);assert.equal(server.state.persistent.get(first).input.join(''),'ONCE');
  pane=page.locator('.terminal-pane:visible').first();page.once('dialog',d=>d.dismiss());await pane.getByRole('button',{name:'End remote session',exact:true}).click();assert(server.state.persistent.has(first));
  page.once('dialog',d=>d.accept());await pane.getByRole('button',{name:'End remote session',exact:true}).click();await pane.getByText('Remote session ended',{exact:true}).waitFor();assert(!server.state.persistent.has(first));assert.equal(server.state.persistent.size,1);
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();assert.equal(await page.locator('.terminal-pane').count(),0);assert.equal(server.state.persistent.size,1);
  assert.deepEqual(errors,[]);console.log('PASS: per-host opt-in, independent split sessions, workspace references, reconnect, app restart restore, termination confirmation, lock/unlock tab restoration without a workspace and fresh MFA.');
 }finally{await app?.close();await server.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
