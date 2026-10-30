'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const password='upgrade-fixture-password';
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-retention-ui-')),file=path.join(dir,'vault.hbr'),backupDir=file+'.backups';let app;
 const launch=()=>electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
 const unlock=async page=>{await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor()};
 try{
  await fs.copyFile(path.join(__dirname,'../tests/fixtures/upgrade-preview7-vault.json'),file);const original=await fs.readFile(file);await fs.mkdir(backupDir);
  // Capture time once: filesystem latency must not reorder the fixture.
  const old=[],oldTime=Date.now()-60*86400000;for(let i=0;i<8;i++){const name=`${oldTime-i}-${crypto.randomUUID()}-manual.hbr`;await fs.writeFile(path.join(backupDir,name),original);old.push(name)}
  const legacy=file+'.backup-'+(Date.now()-90*86400000)+'-'+crypto.randomUUID();await fs.copyFile(file,legacy);
  app=await launch();let page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const invoke=(action,args)=>page.evaluate(({action,args})=>window.harbor.invoke(action,args),{action,args});
  await unlock(page);await page.getByRole('button',{name:'Vault & sync',exact:false}).click();await page.getByRole('button',{name:'Manage backups',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Manage backups',exact:true});await dialog.locator('.backup-row').nth(8).waitFor();
  await dialog.getByRole('button',{name:`Keep ${old.at(-1)}`,exact:true}).click();await dialog.getByRole('button',{name:`Remove Keep from ${old.at(-1)}`,exact:true}).waitFor();assert(await dialog.getByRole('checkbox',{name:`Select ${old.at(-1)}`,exact:true}).isDisabled());
  await dialog.locator('.backup-retention>summary').click();await dialog.getByLabel('Maximum unmarked copies',{exact:true}).selectOption('5');await dialog.getByLabel('Remove copies older than',{exact:true}).selectOption('30');assert(await dialog.getByRole('button',{name:'Save cleanup settings',exact:true}).isDisabled());
  const state=await invoke('vault:retention');await assert.rejects(invoke('vault:saveRetention',{policy:{maxCount:5,maxAgeDays:30},token:state.token}),/Confirm/);
  await dialog.getByRole('checkbox',{name:/I allow Harbor to automatically delete/}).check();await dialog.getByRole('button',{name:'Save cleanup settings',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Saved on this device'}).waitFor();assert.equal((await invoke('vault:backups')).backups.length,9);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,700));assert(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth));await page.screenshot({path:'research/harbor-backup-retention.png'});
  await dialog.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('button',{name:'Back up now',exact:true}).click();await page.getByRole('status').filter({hasText:'Encrypted local backup created'}).waitFor();let backups=(await invoke('vault:backups')).backups;assert.equal(backups.length,5);assert(backups.find(b=>b.id==='local:'+old.at(-1)).kept);await fs.access(legacy);assert.deepEqual(await fs.readFile(file),original);
  await page.getByRole('button',{name:'Manage backups',exact:true}).click();dialog=page.getByRole('dialog',{name:'Manage backups',exact:true});await dialog.locator('.backup-retention>summary').click();await dialog.getByLabel('Remove copies older than',{exact:true}).selectOption('0');await dialog.getByRole('checkbox',{name:/I allow Harbor to automatically delete/}).check();await dialog.getByRole('button',{name:'Save cleanup settings',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Saved on this device'}).waitFor();
  await invoke('vault:lock');await page.getByRole('heading',{name:'Welcome back'}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);await app.close();app=null;
  for(let i=0;i<8;i++)await fs.writeFile(path.join(backupDir,`${Date.now()+i}-${crypto.randomUUID()}-manual.hbr`),original);
  assert((await fs.readdir(backupDir)).length>6);app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await unlock(page);
  await page.waitForFunction(async()=>{const r=await window.harbor.invoke('vault:backups');return r.backups.length===7});
  const final=await invoke('vault:backups');assert.equal(final.limit,5);assert(final.backups.find(b=>b.id==='local:'+old.at(-1)).kept);assert.equal(final.retention.policy.maxAgeDays,0);assert.deepEqual(await fs.readFile(file),original);assert.deepEqual(errors,[]);
  console.log('PASS: Keep marks, protected manual selection, acknowledged policy changes, no deletion on save, count/age pruning on new backup, minimum copies, legacy exclusion, restart persistence, unlock cleanup, compact layout and lock cleanup.');
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
