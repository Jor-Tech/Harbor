'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const password='recovery-ui-test-password';
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-recovery-ui-'));let app;
 const launch=()=>electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
 try{
  app=await launch();let page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const invoke=(action,args)=>page.evaluate(({action,args})=>window.harbor.invoke(action,args),{action,args});
  await page.getByRole('heading',{name:'Create your personal vault'}).waitFor();
  await page.getByRole('button',{name:'Recover a local backup',exact:true}).click();await page.getByText('No local backups found.',{exact:false}).waitFor();await page.getByRole('button',{name:'Close recovery'}).click();
  await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await invoke('entity:save',{collection:'hosts',item:{id:'recover-host',label:'Recovery host',address:'example.test',username:'test',port:22,password:'synthetic-secret'}});
  await page.getByRole('button',{name:'Vault & sync',exact:false}).click();
  await page.getByRole('button',{name:'Back up now',exact:true}).click();await page.getByRole('status').filter({hasText:'Encrypted local backup created'}).waitFor();
  const backup=(await invoke('vault:backups')).backups[0];
  await invoke('entity:delete',{collection:'hosts',id:'recover-host'});
  // Use a synthetic sync folder to verify recovery pauses synchronization.
  const shared=path.join(dir,'shared');await fs.mkdir(shared);await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},shared);
  await invoke('vault:chooseSync');await invoke('vault:autoSync',{enabled:true});await invoke('vault:sync');
  await invoke('terminal:local');await page.getByTitle('Lock vault',{exact:true}).click();await page.getByRole('heading',{name:'Welcome back'}).waitFor();
  await fs.writeFile(path.join(dir,'vault.hbr'),'corrupted encrypted file');
  await page.getByRole('button',{name:'Recover a local backup',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Recover from a local backup'});
  await page.getByLabel('Local backup',{exact:true}).selectOption(backup.id);
  await page.getByLabel('Backup password',{exact:true}).fill('wrong-password');await page.getByRole('button',{name:'Preview backup',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Incorrect password'}).waitFor();assert.equal(await fs.readFile(path.join(dir,'vault.hbr'),'utf8'),'corrupted encrypted file');
  await page.getByLabel('Backup password',{exact:true}).fill(password);await page.getByRole('button',{name:'Preview backup',exact:true}).click();await page.getByRole('heading',{name:'Verified backup contents'}).waitFor();
  assert.equal(await dialog.locator('dt').filter({hasText:/^hosts$/}).evaluate(el=>el.nextElementSibling.textContent),'1');
  assert.equal(await page.getByRole('button',{name:'Restore this backup'}).isDisabled(),true);
  const before=await fs.readFile(path.join(dir,'vault.hbr'));
  await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(await fs.readFile(path.join(dir,'vault.hbr')),before);
  await page.getByRole('button',{name:'Recover a local backup',exact:true}).click();await page.getByLabel('Local backup',{exact:true}).selectOption(backup.id);await page.getByLabel('Backup password',{exact:true}).fill(password);await page.getByRole('button',{name:'Preview backup',exact:true}).click();await page.getByRole('heading',{name:'Verified backup contents'}).waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,700));
  assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));
  await page.screenshot({path:'research/harbor-recovery-preview.png'});
  await page.getByLabel('Replace this device’s vault with this backup',{exact:true}).check();await page.getByRole('button',{name:'Restore this backup'}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();await page.locator('strong').filter({hasText:/^Recovery host$/}).waitFor();
  const recovered=await invoke('vault:read');assert.equal(recovered.settings.autoSync,false);assert.equal(recovered.hosts[0].password,'synthetic-secret');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'device.json'),'utf8')).autoSync,false);
  const copies=await invoke('vault:backups');assert.equal(copies.backups[0].reason,'recovery');assert.equal(await fs.readFile(path.join(dir,'vault.hbr.backups',copies.backups[0].id.slice(6)),'utf8'),'corrupted encrypted file');
  await page.getByRole('button',{name:'Vault & sync',exact:false}).click();await page.getByRole('button',{name:'Recover backup',exact:true}).click();await page.getByLabel('Local backup',{exact:true}).selectOption(backup.id);await page.getByLabel('Backup password',{exact:true}).fill(password);await page.getByRole('button',{name:'Preview backup',exact:true}).click();await page.getByRole('heading',{name:'Verified backup contents'}).waitFor();
  await invoke('settings:save',{fontSize:20});await page.getByLabel('Replace this device’s vault with this backup',{exact:true}).check();await page.getByRole('button',{name:'Restore this backup'}).click();await dialog.getByRole('alert').filter({hasText:'changed'}).waitFor();assert.equal((await invoke('vault:read')).settings.fontSize,20);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Recover backup',exact:true}).click();await invoke('vault:lock');await page.getByRole('heading',{name:'Welcome back'}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
  assert.deepEqual(errors,[]);await app.close();app=null;
  app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();await page.locator('strong').filter({hasText:/^Recovery host$/}).waitFor();assert.equal((await invoke('vault:read')).settings.autoSync,false);
  console.log('PASS: local backup creation, locked-screen damaged-vault recovery, verified preview, wrong-password and cancellation safety, stale preview rejection, compact layout, sync pause, lock cleanup and restart persistence.');
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
