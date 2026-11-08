'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const version=require('../package.json').version;
const notes=require('../electron/release-notes.json'),semver=require('semver');
const password='upgrade-fixture-password';
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-news-ui-')),dataDir=path.join(dir,'data');let app,page;
 const errors=[];
 const launch=async()=>{
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:[...(process.env.HARBOR_EXECUTABLE?[]:[dir]),'--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dataDir}});
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());
  await page.getByLabel('Vault password',{exact:true}).waitFor();
 };
 const unlock=async()=>{await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor()};
 const dialog=()=>page.getByRole('dialog',{name:'What’s new in Harbor',exact:true});
 const noAnnouncement=async()=>{await page.waitForTimeout(1600);assert.equal(await dialog().count(),0)};
 const settings=()=>page.getByRole('button',{name:'Settings',exact:true}).click();
 const stop=async()=>{await app.close();app=null};
 const seed=preferences=>fs.writeFile(path.join(dataDir,'whats-new.json'),JSON.stringify(preferences));
 try{
  await fs.mkdir(dataDir);await fs.copyFile(path.join(__dirname,'../tests/fixtures/upgrade-preview7-vault.json'),path.join(dataDir,'vault.hbr'));
  const vaultBefore=await fs.readFile(path.join(dataDir,'vault.hbr'));
  // Exercise the real installed-app path without adding a production test flag.
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'harbor-news-test',version,main:'main.cjs'}));
  await fs.writeFile(path.join(dir,'main.cjs'),`Object.defineProperty(require('electron').app,'isPackaged',{value:true});require(${JSON.stringify(path.resolve(__dirname,'../electron/main.cjs'))});`);
  await seed({automatic:true,seenVersion:'0.3.0'});await launch();await noAnnouncement();await unlock();
  // An active editor must delay automatic display until it closes.
  await page.getByRole('button',{name:'New host',exact:true}).click();await page.getByRole('dialog',{name:'New host',exact:true}).waitFor();await noAnnouncement();await page.keyboard.press('Escape');
  await dialog().waitFor();assert.equal(await dialog().locator('details[open]').count(),notes.filter(note=>semver.gt(note.version,'0.3.0')&&semver.lte(note.version,version)).length);
  await page.waitForFunction(async version=>(await window.harbor.invoke('whatsNew:status')).pending.length===0,version);
  await page.screenshot({path:'research/harbor-whats-new-auto.png'});
  // Authentication arriving after the overview opens must take priority too.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('auth:prompt',{id:'news-priority',kind:'keyboard-interactive',label:'Fixture host',username:'fixture',hostname:'example.invalid',prompts:[{prompt:'Verification code',echo:false}]}));
  await page.getByRole('heading',{name:'SSH verification',exact:true}).waitFor();await noAnnouncement();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('auth:dismiss',{id:'news-priority'}));await dialog().waitFor();
  await page.keyboard.press('Escape');await noAnnouncement();
  await page.getByTitle('Lock vault',{exact:true}).click();await unlock();await noAnnouncement();
  await settings();const opener=page.getByRole('button',{name:'What’s new',exact:true});await opener.click();await dialog().waitFor();
  assert.equal(await dialog().locator('details[open]').count(),1);
  await dialog().locator('summary').filter({hasText:'0.4.0'}).click();assert.equal(await dialog().locator('details[open]').count(),2);
  await dialog().getByRole('switch',{name:'Show what’s new after updates'}).uncheck();
  await page.waitForFunction(async()=>(await window.harbor.invoke('whatsNew:status')).automatic===false);
  await page.waitForFunction(()=>!document.querySelector('.whats-new-dialog input[role="switch"]').disabled);
  await dialog().getByRole('button',{name:'Get started',exact:true}).focus();
  await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});assert(await opener.evaluate(el=>el===document.activeElement),await page.evaluate(()=>document.activeElement.outerHTML));
  assert(!(await page.getByRole('switch',{name:'Show what’s new after updates'}).isChecked()));
  for(const theme of ['dark','light']){
   await page.getByLabel('Appearance',{exact:true}).selectOption(theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
   for(const width of [1360,390,320]){
    await page.setViewportSize({width,height:844});await opener.click();await dialog().waitFor();
    assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+2));assert(await dialog().evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));
    await page.screenshot({path:`research/harbor-whats-new-${theme}-${width}.png`});await page.keyboard.press('Escape');
   }
   await page.setViewportSize({width:1360,height:900});
  }
  assert.deepEqual(errors,[]);await stop();
  // Repeat a meaningful upgrade with auto-display disabled, then read manually.
  await seed({automatic:false,seenVersion:'0.3.0'});await launch();await unlock();await noAnnouncement();await settings();
  assert(!(await page.getByRole('switch',{name:'Show what’s new after updates'}).isChecked()));
  await page.getByRole('button',{name:'What’s new New',exact:true}).click();await dialog().waitFor();await dialog().getByRole('button',{name:'Get started',exact:true}).click();await stop();
  await seed({automatic:true,seenVersion:version});await launch();await unlock();await noAnnouncement();await stop();
  // Missing state establishes a baseline, without rewriting the existing vault.
  await fs.rm(path.join(dataDir,'whats-new.json'));await fs.writeFile(path.join(dataDir,'vault.hbr'),vaultBefore);
  await launch();await unlock();await noAnnouncement();assert.deepEqual(await fs.readFile(path.join(dataDir,'vault.hbr')),vaultBefore);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir,'whats-new.json'),'utf8')),{automatic:true,seenVersion:version});assert.deepEqual(errors,[]);
  console.log('PASS: automatic meaningful highlights, dialog priority, once-only acknowledgment, first-run baseline, manual history, persistent opt-out, keyboard focus and responsive light/dark layouts.');
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
