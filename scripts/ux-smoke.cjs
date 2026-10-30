'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');

// A real Electron renderer and isolated vault; never touches the user's saved hosts.
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-ux-'));
 const screenshotDir=path.resolve('research');let app;
 try{
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const nav=async name=>{await page.locator('.sidebar').getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name:name==='Vault & sync'?'Vault':name,exact:true}).waitFor()};
  const screenshot=async name=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:path.join(screenshotDir,`harbor-ux-${name}.png`)})};
  const fits=async label=>{
   const overflowing=await page.evaluate(()=>[...document.querySelectorAll('.page-content,.toolbar,.host-browser-controls,.editor,.settings,.file-manager,.mcp-manager,.gate-form-area,.workspace-tools')].filter(e=>e.checkVisibility()&&e.scrollWidth>e.clientWidth+2).map(e=>({element:e.className,width:e.clientWidth,content:e.scrollWidth})));
   assert.deepEqual(overflowing,[],`${label}: horizontal overflow`);
  };
  const password='Harbor-UX-test-password';
  await page.getByRole('heading',{name:'Create your personal vault'}).waitFor();
  await page.setViewportSize({width:390,height:844});await fits('mobile vault');await screenshot('vault-mobile');
  await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await page.setViewportSize({width:1440,height:960});
  // Modal focus cannot escape into the workspace, and closing restores the opener.
  const newHost=page.getByRole('button',{name:'New host',exact:true});await newHost.click();
  const dialog=page.getByRole('dialog',{name:'New host',exact:true});await dialog.waitFor();
  await dialog.getByRole('button',{name:'Save',exact:true}).focus();await page.keyboard.press('Tab');
  assert(await page.evaluate(()=>document.activeElement.closest('dialog')!==null),'Tab stays inside editor');
  await page.keyboard.press('Shift+Tab');
  assert(await page.evaluate(()=>document.activeElement.closest('dialog')!==null),'Shift Tab stays inside editor');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert(await newHost.evaluate(e=>e===document.activeElement),'Escape restores editor opener');
  // A backend validation failure is announced inside the native dialog's top layer.
  await newHost.click();await page.getByLabel('Label',{exact:true}).fill('x'.repeat(201));await page.getByLabel('Address',{exact:true}).fill('test.example.test');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await dialog.getByRole('alert').waitFor();await screenshot('editor-error');await page.keyboard.press('Escape');
  // Seed representative non-sensitive data through the same backend used by the UI.
  await page.evaluate(async()=>{
   await window.harbor.invoke('entity:save',{collection:'groups',item:{label:'Production infrastructure with a longer group name',color:'purple'}});
   for(const h of [{label:'Production web',address:'web.example.test',username:'deploy',color:'blue',tags:'production, web'},{label:'Analytics database with a longer descriptive name',address:'analytics.infrastructure.example.test',username:'postgres',color:'purple',tags:'database'},{label:'Development',address:'dev.example.test',username:'developer',color:'green'}])await window.harbor.invoke('entity:save',{collection:'hosts',item:{...h,port:22}});
   await window.harbor.invoke('entity:save',{collection:'snippets',item:{label:'Disk usage',command:'df -h'}});
  });
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await nav('Hosts');await screenshot('hosts-desktop');
  await page.getByRole('button',{name:'Filters',exact:true}).click();await screenshot('host-filters');await page.getByRole('button',{name:'Filters',exact:true}).click();
  for(const section of ['Snippets','Keychain','Port Forwarding','Known Hosts','History']){
   await nav(section);await page.locator('#search').fill('missing-needle');await page.getByRole('heading',{name:'No results found',exact:true}).waitFor();
   await page.getByRole('button',{name:'Clear search',exact:true}).click();assert.equal(await page.locator('#search').inputValue(),'');
  }
  await nav('Snippets');assert(await page.getByRole('button',{name:'Run in terminal',exact:true}).isDisabled());
  await nav('Settings');await page.getByLabel('Appearance',{exact:true}).selectOption('light');
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await nav('Hosts');await screenshot('hosts-light');
  // A new page should start at the heading, not inherit a previous page's scroll position.
  await nav('Settings');await page.locator('.page-content').evaluate(e=>e.scrollTop=e.scrollHeight);await nav('Hosts');
  assert.equal(await page.locator('.page-content').evaluate(e=>e.scrollTop),0);
  for(const width of [960,768,390,320]){
   await page.setViewportSize({width,height:844});
   for(const section of ['Hosts','Workspaces','SFTP','Snippets','Port Forwarding','Keychain','Known Hosts','History','Settings','Vault & sync']){await nav(section);await fits(`${section} at ${width}px`)}
   await nav('Settings');await page.getByRole('button',{name:'Manage local MCP',exact:true}).click();await page.getByRole('heading',{name:'Local MCP access',exact:true}).waitFor();await fits(`MCP at ${width}px`);
  }
  await page.setViewportSize({width:390,height:844});await nav('Hosts');
  await page.getByTitle('List view',{exact:true}).click();await fits('mobile list');await screenshot('hosts-mobile');
  await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await screenshot('navigation-mobile');
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Expand sidebar',exact:true}).count(),1,'Escape closes navigation');
  await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await nav('Settings');assert.equal(await page.getByRole('button',{name:'Expand sidebar',exact:true}).count(),1,'Choosing a page closes the mobile drawer');
  await screenshot('settings-mobile');await nav('Vault & sync');await screenshot('vault-settings-mobile');await nav('Settings');await page.getByRole('button',{name:'Manage local MCP',exact:true}).click();await screenshot('mcp-mobile');await nav('Settings');await page.getByLabel('Appearance',{exact:true}).selectOption('dark');await nav('Hosts');await screenshot('hosts-mobile-dark');
  await newHost.click();await screenshot('editor-mobile');await fits('mobile editor');await page.keyboard.press('Escape');
  // A failed SFTP/local listing remains understandable after a transient toast disappears.
  await page.setViewportSize({width:1440,height:960});await nav('SFTP');
  const local=page.getByRole('region',{name:'Local files',exact:true});
  const missing=path.join(dir,'retry-folder');await page.getByLabel('Local path',{exact:true}).fill(missing);await local.getByRole('button',{name:'Go',exact:true}).click();
  await local.getByRole('alert').waitFor();await screenshot('sftp-error');await fs.mkdir(missing);await local.getByRole('button',{name:'Retry local folder',exact:true}).click();await local.getByText('This folder is empty.',{exact:true}).waitFor();assert.equal(await local.getByRole('alert').count(),0);
  await page.setViewportSize({width:390,height:844});await screenshot('sftp-mobile');
  await nav('Hosts');await page.getByRole('button',{name:'Local terminal',exact:true}).click();await page.locator('.terminal-pane:visible').getByText('Connected',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Search terminal',exact:true}).click();await fits('mobile terminal');await screenshot('terminal-mobile');await page.getByRole('button',{name:'Close terminal search',exact:true}).click();
  await page.setViewportSize({width:1440,height:960});await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByText('Disconnected',{exact:true}).waitFor();
  await nav('Snippets');assert(await page.getByRole('button',{name:'Run in terminal',exact:true}).isDisabled(),'Disconnected tabs cannot run snippets');
  const closeTab=page.getByRole('button',{name:'Close Local terminal tab',exact:true});await closeTab.focus();await closeTab.press('Enter');await closeTab.waitFor({state:'hidden'});
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await page.getByTitle('Lock vault',{exact:true}).click();await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();
  assert.equal(await page.locator('.titlebar').evaluate(e=>e.inert),false,'Locking from mobile navigation must not leave the titlebar inert');
  await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('button',{name:'Expand sidebar',exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS: responsive main screens at 1440/960/768/390/320px, light/dark, modal focus/return, modal errors, search recovery, scroll reset, SFTP retry, mobile navigation and keyboard tab close.');
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
