'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const expected=require('../tests/fixtures/upgrade-preview7-expected.json');
const {RELEASES_URL}=require('../electron/releases.cjs');
const {installerNames,API_URL}=require('../electron/update-checker.cjs');
const password='upgrade-fixture-password';
function persisted(data){const {effectiveHosts,groupDefaults,...rest}=data;const {syncFolder,autoSync,...settings}=rest.settings;return {...rest,settings}}

(async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-release-ui-')),vaultFile=path.join(dir,'vault.hbr');let app;
  const launch=()=>electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  const unlock=async page=>{await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor()};
  try {
    await fs.copyFile(path.join(__dirname,'../tests/fixtures/upgrade-preview7-vault.json'),vaultFile);
    const before=await fs.readFile(vaultFile),syncFolder=path.join(dir,'existing-sync-folder');await fs.mkdir(syncFolder);
    const device={syncFolder,autoSync:false};await fs.writeFile(path.join(dir,'device.json'),JSON.stringify(device));
    app=await launch();let page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.getByRole('heading',{name:'Welcome back'}).waitFor();
    await assert.rejects(page.evaluate(()=>window.harbor.invoke('vault:unlock',{password:'wrong-fixture-password'})));
    assert.deepEqual(await fs.readFile(vaultFile),before,'An incorrect password must not overwrite the old vault');
    await unlock(page);
    let data=await page.evaluate(()=>window.harbor.invoke('vault:read'));assert.deepEqual(persisted(data),expected);assert.equal(data.settings.syncFolder,syncFolder);
    assert.deepEqual(await fs.readFile(vaultFile),before,'Opening an existing vault must not rewrite it');
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    const info=await page.evaluate(()=>window.harbor.invoke('releases:info'));
    assert.equal(info.version,require('../package.json').version);assert.equal(info.packaged,!!process.env.HARBOR_EXECUTABLE);assert.equal(info.arch,process.arch);
    await page.locator('.release-version').filter({hasText:info.version}).waitFor();
    // Stub the OS browser boundary; tests never contact GitHub or open a real browser.
    await app.evaluate(({shell})=>{global.openedReleaseLinks=[];shell.openExternal=async url=>{global.openedReleaseLinks.push(url)}});
    await page.getByRole('button',{name:'View releases & downloads',exact:true}).click();
    assert.deepEqual(await app.evaluate(()=>global.openedReleaseLinks),[RELEASES_URL]);
    await page.evaluate(()=>window.harbor.invoke('releases:open',{url:'https://untrusted.example',target:'file:///etc/passwd'}));
    assert.deepEqual(await app.evaluate(()=>global.openedReleaseLinks),[RELEASES_URL,RELEASES_URL]);
    await app.evaluate(({shell})=>{shell.openExternal=async()=>{throw new Error('No browser is configured')}});
    await page.getByRole('button',{name:'View releases & downloads',exact:true}).click();await page.getByRole('alert').filter({hasText:'No browser is configured'}).waitFor();
    // Network is replaced at the main-process boundary; no GitHub requests or personal data.
    const rows=['98.0.0','99.0.0-beta.2'].map(version=>({tag_name:'v'+version,draft:false,prerelease:version.includes('-'),published_at:'2026-10-30T10:00:00Z',html_url:'https://untrusted.example',assets:installerNames(version,process.platform,process.arch).map(name=>({name,state:'uploaded',size:100}))}));
    await app.evaluate((_electron,rows)=>{global.updateRequests=[];global.fetch=async(url,options)=>{global.updateRequests.push({url,credentials:options.credentials,redirect:options.redirect,headers:options.headers});return new Response(JSON.stringify(rows),{status:200})}},rows);
    const initialPreferences=(await page.evaluate(()=>window.harbor.invoke('updates:status'))).preferences;
    assert.equal(initialPreferences.automatic,false);
    assert.equal(initialPreferences.includePreviews,info.version.includes('-'),'Only prerelease builds default to preview updates');
    await page.getByRole('button',{name:'Check now',exact:true}).click();await page.getByText(`Harbor ${initialPreferences.includePreviews?'99.0.0-beta.2':'98.0.0'} is available.`,{exact:true}).waitFor();
    assert(await page.getByRole('button',{name:'View available update',exact:true}).isVisible());
    const requests=await app.evaluate(()=>global.updateRequests);assert.equal(requests.length,1);assert.equal(requests[0].url,API_URL+'?per_page=100&page=1');assert.equal(requests[0].credentials,'omit');assert.equal(requests[0].redirect,'error');assert(!requests[0].headers.Authorization);
    await page.getByRole('switch',{name:'Include preview releases',exact:true}).check();await page.getByText('Harbor 99.0.0-beta.2 is available.',{exact:true}).waitFor();
    await page.getByRole('switch',{name:'Include preview releases',exact:true}).uncheck();await page.getByText('Harbor 98.0.0 is available.',{exact:true}).waitFor();
    assert.equal((await app.evaluate(()=>global.updateRequests)).length,1,'Changing channel reuses the checked metadata');
    await app.evaluate(({shell})=>{shell.openExternal=async url=>global.openedReleaseLinks.push(url)});
    await page.getByRole('button',{name:'View releases & downloads',exact:true}).click();assert.equal((await app.evaluate(()=>global.openedReleaseLinks)).at(-1),RELEASES_URL);
    await page.evaluate(()=>window.harbor.invoke('updates:open',{url:'https://untrusted.example'}));assert.equal((await app.evaluate(()=>global.openedReleaseLinks)).at(-1),RELEASES_URL+'/tag/v98.0.0');
    await page.getByRole('switch',{name:'Automatically check for updates',exact:true}).check();
    await page.waitForFunction(async()=>(await window.harbor.invoke('updates:status')).preferences.automatic);
    assert.deepEqual(await fs.readFile(vaultFile),before,'Update preferences must not modify the vault');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'updates.json'),'utf8')),{automatic:true,includePreviews:false});
    await page.getByRole('button',{name:'Hosts',exact:true}).click();await page.getByRole('button',{name:'View available update',exact:true}).click();await page.getByRole('heading',{name:'Releases & updates',exact:true}).waitFor();
    await page.screenshot({path:'research/harbor-release-settings.png'});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,700));
    assert(await page.locator('.page-content').evaluate(el=>el.scrollWidth<=el.clientWidth));
    // Exercise the real IPC/UI state machine, replacing only the updater/OS
    // boundaries. Never download installers or replace an installed app in CI.
    await app.evaluate(({app})=>{
      const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
      global.testRequire=require;
      const {UpdateInstaller}=require(require('node:path').join(app.getAppPath(),'electron/update-installer.cjs'));
      const snapshot=UpdateInstaller.prototype.snapshot;
      UpdateInstaller.prototype.snapshot=function(){global.testInstaller=this;return snapshot.call(this)};
    });
    await page.evaluate(()=>window.harbor.invoke('updates:status'));
    await app.evaluate(()=>{
      const require=global.testRequire;
      const installer=global.testInstaller;
      installer.support={supported:true,kind:'deb'};installer.platform='linux';installer.arch='x64';
      global.installAttempts=0;
      installer.installDeb=async()=>{global.installAttempts++;await new Promise((_resolve,reject)=>{global.failInstallation=()=>reject(new Error('Test permission declined'))})};
      installer.createUpdater=()=>{
        const updater=new (require('node:events').EventEmitter)();
        updater.setFeedURL=feed=>{global.updateFeed=feed};
        updater.checkForUpdates=async()=>({updateInfo:{version:'98.0.0',files:[{url:'Harbor-98.0.0-linux-amd64.deb',size:100,sha512:require('node:crypto').createHash('sha512').update('fixture').digest('base64')}]}});
        updater.downloadUpdate=token=>new Promise((resolve,reject)=>{
          global.finishDownload=()=>resolve(['/synthetic/verified.deb']);
          global.failDownload=()=>reject(new Error('Test checksum mismatch'));
          token.onCancel(()=>reject(new Error('Cancelled')));
          updater.emit('download-progress',{percent:42});
        });
        return updater;
      };
      installer.changed({phase:'idle'});
    });
    await page.getByRole('button',{name:'Download update',exact:true}).click();
    await page.getByRole('progressbar',{name:'Update download progress'}).waitFor();
    assert.equal(await page.getByRole('progressbar').getAttribute('value'),'42');
    assert(await page.getByRole('button',{name:'Check now',exact:true}).isDisabled());
    assert(await page.getByRole('switch',{name:'Include preview releases',exact:true}).isDisabled());
    await page.getByRole('button',{name:'Cancel download',exact:true}).click();
    await page.getByRole('button',{name:'Download update',exact:true}).waitFor();
    await page.getByRole('button',{name:'Download update',exact:true}).click();
    await page.getByRole('progressbar').waitFor();await app.evaluate(()=>global.failDownload());
    await page.getByRole('alert').filter({hasText:'Could not download or verify'}).waitFor();
    await page.getByRole('button',{name:'Retry download',exact:true}).click();
    await page.getByRole('progressbar').waitFor();
    await page.getByRole('button',{name:'Hosts',exact:true}).click();
    await app.evaluate(()=>global.finishDownload());
    await page.getByRole('button',{name:'View available update',exact:true}).filter({hasText:'Update ready'}).waitFor();
    await page.getByRole('button',{name:'View available update',exact:true}).click();
    await page.getByText('Harbor 98.0.0 is ready to install.',{exact:true}).waitFor();
    assert.equal((await app.evaluate(()=>global.updateFeed)).url,RELEASES_URL+'/download/v98.0.0/');
    assert.equal(await app.evaluate(()=>global.installAttempts),0);
    await page.getByRole('button',{name:'Install and restart',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:'research/harbor-update-ready.png'});
    assert(await page.locator('.release-settings').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async(_win,options)=>{global.updateConfirmation=options;return {response:0}}});
    await page.getByRole('button',{name:'Install and restart',exact:true}).click();
    await page.waitForFunction(async()=>(await window.harbor.invoke('updates:status')).installation.phase==='downloaded');
    assert.equal(await app.evaluate(()=>global.installAttempts),0);
    assert.match((await app.evaluate(()=>global.updateConfirmation)).detail,/disconnect/);
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})});
    await page.getByRole('button',{name:'Install and restart',exact:true}).click();
    await page.getByText('Installing update…',{exact:true}).waitFor();
    await assert.rejects(page.evaluate(()=>window.harbor.invoke('settings:save',{fontSize:18})),/installing an update/);
    await app.evaluate(()=>global.failInstallation());
    await page.getByRole('alert').filter({hasText:'Installation was cancelled or failed'}).waitFor();
    assert.equal(await app.evaluate(()=>global.installAttempts),1);
    await page.getByRole('button',{name:'Dismiss update',exact:true}).click();
    await page.getByRole('button',{name:'Download update',exact:true}).waitFor();
    // A write followed by a process restart must preserve every existing collection.
    const saved=await page.evaluate(()=>window.harbor.invoke('settings:save',{fontSize:16}));
    assert.deepEqual(persisted(saved),{...expected,settings:{...expected.settings,fontSize:16}});
    assert.deepEqual(errors,[]);await app.close();app=null;
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'device.json'),'utf8')),device);
    app=await launch();await app.evaluate(()=>{global.fetch=async()=>new Response('{}',{status:404})});page=await app.firstWindow();page.setDefaultTimeout(15000);await unlock(page);
    data=await page.evaluate(()=>window.harbor.invoke('vault:read'));assert.deepEqual(persisted(data),{...expected,settings:{...expected.settings,fontSize:16}});
    assert.equal(data.settings.syncFolder,syncFolder);assert.equal(data.settings.autoSync,false);
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.screenshot({path:'research/harbor-release-settings.png'});
    assert(await page.getByRole('switch',{name:'Automatically check for updates',exact:true}).isChecked());
    assert(!(await page.getByRole('switch',{name:'Include preview releases',exact:true}).isChecked()));
    await page.getByRole('switch',{name:'Automatically check for updates',exact:true}).uncheck();
    await page.getByRole('button',{name:'Check now',exact:true}).click();await page.getByText(/Public release information is not available/).waitFor();
    assert.equal(await page.getByRole('button',{name:'View available update',exact:true}).count(),0);
    assert(await page.locator('.release-settings').evaluate(el=>el.scrollWidth<=el.clientWidth));
    console.log('PASS: existing vault survives unlock, edits and restart; release checks, fixed links, download progress/cancellation/retry, ready notification, install confirmation and permission failure, device preferences and compact layout.');
  } finally {await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
