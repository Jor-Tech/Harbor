'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {Vault}=require('../electron/vault.cjs');
async function until(check){for(let i=0;i<450;i++){if(await check())return;await new Promise(r=>setTimeout(r,100))}throw new Error('Timed out waiting for sync condition')}
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-sync-ui-')),folder=path.join(dir,'shared'),password='Harbor-sync-test-password';await fs.mkdir(folder);let app;
 try{
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:path.join(dir,'profile')}});const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await page.evaluate(()=>window.harbor.invoke('entity:save',{collection:'hosts',item:{label:'Sync server',address:'sync.example.test',port:22,username:'test',password:'SECRET_LOCAL_PASSWORD'}}));
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},folder);
  await page.getByRole('button',{name:/Vault & sync/}).click();await page.getByRole('button',{name:'Choose folder',exact:true}).click();assert.equal(await page.getByLabel('Automatically sync on this device').isChecked(),false);
  await page.getByLabel('Automatically sync on this device').click();await until(()=>page.evaluate(async()=>((await window.harbor.invoke('vault:syncStatus')).lastResult)==='pushed'));
  const shared=path.join(folder,(await fs.readdir(folder)).find(f=>f.endsWith('.harbor-vault'))),remote=new Vault(path.join(dir,'remote.hbr'));await remote.importFrom(shared,password);
  assert.equal((await remote.read()).settings.autoSync,undefined);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'profile/device.json'),'utf8')).autoSync,true);
  // A real polling pull updates the UI while an open editor keeps its original baseline.
  await page.locator('nav').getByRole('button',{name:/^Hosts/}).click();await page.locator('.host-card .host-body').click();await page.getByLabel('Label',{exact:true}).fill('Unsaved local edit');
  let d=await remote.read();d.hosts[0].label='Changed remotely';await remote.save(d);await remote.sync(folder);
  await until(()=>page.evaluate(async()=>((await window.harbor.invoke('vault:read')).hosts[0].label)==='Changed remotely'));
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('This item changed since you opened it. Close and reopen the editor before saving.',{exact:true}).waitFor();await page.getByTitle('Close editor',{exact:true}).click();
  assert.equal((await page.evaluate(()=>window.harbor.invoke('vault:read'))).hosts[0].label,'Changed remotely');
  await page.getByRole('button',{name:/Vault & sync/}).click();await page.getByLabel('Automatically sync on this device').click();await until(()=>page.evaluate(async()=>!(await window.harbor.invoke('vault:read')).settings.autoSync));
  await page.evaluate(async()=>{const d=await window.harbor.invoke('vault:read');await window.harbor.invoke('entity:save',{collection:'hosts',item:{...d.hosts[0],label:'Local conflict',password:'SECRET_CHANGED_PASSWORD'}});await window.harbor.invoke('entity:save',{collection:'snippets',item:{label:'Keep local command',command:'SECRET_COMMAND'}})});
  d=await remote.read();d.hosts[0].address='shared.example.test';await remote.save(d);await remote.sync(folder);
  await page.getByLabel('Automatically sync on this device').click();await page.getByRole('button',{name:'Compare changes',exact:true}).waitFor();await page.getByRole('button',{name:'Compare changes',exact:true}).click();await page.getByRole('heading',{name:'Compare vault changes',exact:true}).waitFor();
  const comparison=page.getByRole('dialog',{name:'Compare vault changes',exact:true});assert(!(await comparison.innerText()).includes('SECRET_'));assert.equal(await comparison.getByRole('button',{name:'Apply choices',exact:true}).isDisabled(),true);
  await comparison.getByRole('button',{name:'Keep this device',exact:true}).click();await comparison.getByLabel('hosts: Local conflict — Shared vault',{exact:true}).check();await page.screenshot({path:'research/harbor-vault-comparison.png'});
  // Applying an old comparison cannot overwrite another local edit.
  await page.evaluate(()=>window.harbor.invoke('settings:save',{fontSize:16}));await comparison.getByRole('button',{name:'Apply choices',exact:true}).click();await comparison.getByText('A vault changed since this comparison. Refresh the comparison before applying choices.',{exact:true}).waitFor();await comparison.getByRole('button',{name:'Refresh comparison',exact:true}).click();await comparison.getByRole('button',{name:'Keep this device',exact:true}).click();await comparison.getByLabel('hosts: Local conflict — Shared vault',{exact:true}).check();await comparison.getByRole('button',{name:'Apply choices',exact:true}).click();await comparison.waitFor({state:'hidden'});
  let merged=await page.evaluate(()=>window.harbor.invoke('vault:read'));assert.equal(merged.hosts[0].address,'shared.example.test');assert.equal(merged.snippets[0].command,'SECRET_COMMAND');assert.equal(merged.settings.fontSize,16);await remote.sync(folder);assert.equal((await remote.read()).snippets.length,1);
  await page.screenshot({path:'research/harbor-auto-sync.png'});
  const before=await fs.readFile(shared);await page.evaluate(()=>window.harbor.invoke('entity:save',{collection:'snippets',item:{label:'Pending on lock',command:'pending'}}));await page.getByTitle('Lock vault',{exact:true}).click();await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();await page.waitForTimeout(2500);assert.deepEqual(await fs.readFile(shared),before);
  await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByLabel('Automatically sync on this device').waitFor();
  // Idle can mean a scheduled sync has not started yet. Pause automatic work
  // and await the manual sync promise to drain any in-flight operation.
  await page.evaluate(async()=>{await window.harbor.invoke('vault:sync');await window.harbor.invoke('vault:autoSync',{enabled:false});await window.harbor.invoke('vault:sync')});
  // An unavailable shared folder is not recreated, and errors remain visible.
  const offline=folder+'-offline';await fs.rename(folder,offline);await page.evaluate(()=>window.harbor.invoke('vault:autoSync',{enabled:true}));await until(()=>page.evaluate(async()=>(await window.harbor.invoke('vault:syncStatus')).phase==='error'));const failure=await page.evaluate(async()=>{try{await window.harbor.invoke('vault:sync');return ''}catch(e){return e.message}});assert.match(failure,/unavailable/);await page.waitForTimeout(2500);await assert.rejects(fs.access(folder));await fs.rename(offline,folder);await page.evaluate(()=>window.harbor.invoke('vault:sync'));
  assert.deepEqual(errors,[]);console.log('PASS: opt-in automatic push/pull, device-only preference, stale-editor protection, redacted mixed conflict choices, stale comparison rejection, lock cancellation and missing-folder pause.');
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
