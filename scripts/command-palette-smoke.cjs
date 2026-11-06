'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createTerminalServer}=require('../tests/helpers/terminal-server.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-palette-ui-')),server=await createTerminalServer();let app,page;
 try{
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const shortcut=process.platform==='darwin'?'Meta+k':'Control+k';
  const palette=page.getByRole('dialog',{name:'Command palette',exact:true}),input=page.getByRole('combobox',{name:'Search hosts, terminals, workspaces and actions'});
  const open=async query=>{await page.keyboard.press(shortcut);await palette.waitFor();if(query!==undefined)await input.fill(query)};
  const execute=async query=>{await open(query);await input.press('Enter');await palette.waitFor({state:'hidden'})};
  await page.getByLabel('Vault password',{exact:true}).waitFor();await page.keyboard.press(shortcut);assert.equal(await palette.count(),0);
  const password='Harbor-palette-test-password';await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})});
  await page.evaluate(async host=>{await window.harbor.invoke('entity:save',{collection:'hosts',item:{...host,label:'Palette alpha',tags:'staging',persistentSession:true,password:'test-password'}})},server.host);
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  const opener=page.getByRole('button',{name:'Open command palette',exact:true});await opener.click();await palette.waitFor();
  assert(await input.evaluate(e=>e===document.activeElement));await input.fill('no-such-result');await palette.getByText('No results found',{exact:true}).waitFor();await input.press('ArrowDown');await input.press('Enter');assert(await palette.isVisible());
  await input.fill('');const before=await input.getAttribute('aria-activedescendant');await input.press('ArrowDown');assert.notEqual(await input.getAttribute('aria-activedescendant'),before);await input.press('ArrowUp');assert.equal(await input.getAttribute('aria-activedescendant'),before);
  await palette.getByRole('button',{name:'Close command palette'}).focus();await page.keyboard.press('Tab');assert(await page.evaluate(()=>!!document.activeElement.closest('.command-palette-dialog')));await page.keyboard.press('Escape');assert(await opener.evaluate(e=>e===document.activeElement));
  await execute('staging');const pane=page.locator('.terminal-pane:visible');await pane.getByText('Connected',{exact:true}).waitFor();
  // Shortcut must be captured before xterm can transmit Ctrl+K to SSH.
  await pane.locator('.xterm-helper-textarea').focus();await open('Palette alpha');assert.equal(await palette.getByRole('option').count(),2);assert.equal(server.received.join(''),'');await input.press('Enter');await palette.waitFor({state:'hidden'});assert.equal(server.state.connections,1);
  await page.getByRole('button',{name:'Save workspace',exact:true}).click();await page.getByLabel('Workspace name').fill('Palette saved pair');await page.getByRole('button',{name:'Save layout',exact:true}).click();await page.getByLabel('Workspace name').waitFor({state:'hidden'});
  await execute('Palette saved pair');await page.waitForFunction(()=>document.querySelectorAll('.terminal-pane').length===2);assert.equal(server.state.persistent.size,1);
  await execute('new host');await page.getByRole('dialog',{name:'New host',exact:true}).waitFor();await page.keyboard.press(shortcut);assert.equal(await palette.count(),0);await page.keyboard.press('Escape');
  // An authentication prompt arriving while search is open takes precedence.
  await open('alpha');server.state.otp=true;
  await page.evaluate(()=>{window.palettePending=window.harbor.invoke('vault:read').then(d=>window.harbor.invoke('terminal:connect',{hostId:d.hosts[0].id})).catch(()=>null)});
  await page.getByRole('heading',{name:'SSH verification',exact:true}).waitFor();await palette.waitFor({state:'hidden'});await page.keyboard.press(shortcut);assert.equal(await palette.count(),0);await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.evaluate(()=>window.palettePending);await page.getByRole('heading',{name:'SSH verification',exact:true}).waitFor({state:'hidden'});server.state.otp=false;
  await execute('open settings');await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
  for(const theme of ['light','dark']){
   await page.getByLabel('Appearance',{exact:true}).selectOption(theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);await page.waitForTimeout(200); // Let the existing color transitions finish before visual checks.
   for(const width of [1440,390,320]){await page.setViewportSize({width,height:844});await open('alpha');assert(await palette.evaluate(e=>e.scrollWidth<=e.clientWidth+2));assert(await palette.evaluate(e=>getComputedStyle(e.querySelector('[role=option]')).color===getComputedStyle(e).color),'Result text follows the active theme');await page.screenshot({path:`research/harbor-palette-${theme}-${width}.png`});await page.keyboard.press('Escape')}
  }
  await page.setViewportSize({width:1440,height:960});await open('lock vault');await input.press('Enter');await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();assert.equal(await palette.count(),0);await page.keyboard.press(shortcut);assert.equal(await palette.count(),0);assert.equal(await page.locator('.terminal-pane').count(),0);
  await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await opener.waitFor();await open('alpha');await page.evaluate(()=>window.harbor.invoke('vault:lock'));await palette.waitFor({state:'hidden'});assert.equal(await page.getByRole('combobox').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS: all palette categories, keyboard selection, focus trap/return, no results, terminal shortcut isolation, workspace restore, editor/MFA priority, themes, narrow windows and vault lock.');
 }catch(error){if(page){console.log('Open dialogs:',await page.locator('dialog[open]').allTextContents());await page.screenshot({path:'research/harbor-palette-failure.png'})}throw error;}finally{await app?.close();await server.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
