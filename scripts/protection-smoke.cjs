'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const password='upgrade-fixture-password';
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-protection-ui-')),file=path.join(dir,'vault.hbr');let app;
 const launch=()=>electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
 const unlock=async page=>{await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor()};
 try{
  await fs.copyFile(path.join(__dirname,'../tests/fixtures/upgrade-preview7-vault.json'),file);const before=await fs.readFile(file);
  app=await launch();let page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await unlock(page);
  await page.getByRole('button',{name:'Update vault format',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Update vault format'});
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(await fs.readFile(file),before);
  await assert.rejects(page.evaluate(p=>window.harbor.invoke('vault:upgradeEncryption',{password:p}),password),/Confirm/);
  await page.getByRole('button',{name:'Update vault format',exact:true}).click();dialog=page.getByRole('dialog',{name:'Update vault format'});
  await dialog.getByLabel('Current vault password',{exact:true}).fill('incorrect-password');assert(await dialog.getByRole('button',{name:'Update this vault',exact:true}).isDisabled());
  await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'Update this vault',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Incorrect password'}).waitFor();assert.deepEqual(await fs.readFile(file),before);
  await dialog.getByLabel('Current vault password',{exact:true}).fill(password);await page.screenshot({path:'research/harbor-protection-upgrade.png'});
  await dialog.getByRole('button',{name:'Update this vault',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(JSON.parse(await fs.readFile(file,'utf8')).kdf.N,131072);
  await page.getByRole('button',{name:'Vault & sync',exact:false}).click();await page.getByRole('heading',{name:'Your vault. Your rules.',exact:true}).waitFor();assert.equal(await page.locator('.vault-protection-banner').count(),0);assert.equal(await page.getByRole('button',{name:'Update vault format',exact:true}).count(),0);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,700));assert(await page.locator('.page-content').evaluate(e=>e.scrollWidth<=e.clientWidth));await page.screenshot({path:'research/harbor-protection-active.png'});
  assert.deepEqual(errors,[]);await app.close();app=null;app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);await unlock(page);assert.deepEqual(await page.evaluate(()=>window.harbor.invoke('vault:security')),{version:2,needsUpgrade:false});
  console.log('PASS: explicit vault upgrade requires confirmation/password, preserves cancelled/failed attempts, hides migration banners for current vaults and survives restart.');
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
