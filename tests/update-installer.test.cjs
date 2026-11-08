'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const {UpdateInstaller,installationSupport,validateUpdateInfo,installDeb}=require('../electron/update-installer.cjs');
const {UpdateChecker}=require('../electron/update-checker.cjs');
const {RELEASES_URL}=require('../electron/releases.cjs');
const target={version:'0.5.0',tag:'v0.5.0',url:'https://untrusted.example'};
const file={url:'Harbor-0.5.0-linux-amd64.deb',size:100,sha512:createHash('sha512').update('fixture').digest('base64')};
const info=()=>({version:target.version,files:[{...file}]});
function fixture(overrides={}){
 const calls=[],events=[];let updater;
 const installer=new UpdateInstaller({version:'0.4.1',platform:'linux',arch:'x64',support:{supported:true,kind:'deb'},
  createUpdater:()=>{updater=new EventEmitter();updater.setFeedURL=feed=>calls.push(['feed',feed]);updater.checkForUpdates=async()=>({updateInfo:info()});updater.downloadUpdate=async()=>{calls.push(['download']);updater.emit('download-progress',{percent:55.8});return ['/tmp/verified.deb']};updater.quitAndInstall=(...args)=>calls.push(['install',...args]);return updater},
  createToken:()=>({cancelled:false,cancel(){this.cancelled=true}}),emit:()=>events.push(installer.snapshot()),beforeInstall:async()=>calls.push(['flush']),installDeb:async f=>calls.push(['deb',f]),...overrides});
 return {installer,calls,events,get updater(){return updater}};
}
test('only installed supported formats can update; unsigned macOS and development builds stay manual',async t=>{
 const resourcesPath=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-update-support-'));t.after(()=>fs.rm(resourcesPath,{recursive:true,force:true}));
 const base={packaged:true,platform:'linux',arch:'x64',resourcesPath};
 assert.equal((await installationSupport(base)).supported,false);
 assert.equal((await installationSupport({...base,appImage:'/tmp/Harbor.AppImage'})).kind,'appimage');
 await fs.writeFile(path.join(resourcesPath,'package-type'),'deb');
 assert.equal((await installationSupport(base)).kind,'deb');
 assert.equal((await installationSupport({...base,platform:'win32'})).kind,'nsis');
 for(const extra of [{packaged:false},{platform:'darwin'},{arch:'arm64'}])assert.equal((await installationSupport({...base,...extra})).supported,false);
});
test('downloads pin the checked tag, verify metadata before downloading, and never auto-install',async()=>{
 const f=fixture(),first=f.installer.download(target);assert.equal(f.installer.download(target),first);
 assert.equal((await first).phase,'downloaded');
 assert.equal(f.calls[0][1].url,RELEASES_URL+'/download/v0.5.0/');
 assert.equal(f.calls[0][1].channel,'latest');
 assert.equal(f.updater.autoDownload,false);assert.equal(f.updater.autoInstallOnAppQuit,false);assert.equal(f.updater.allowDowngrade,false);assert.equal(f.updater.disableDifferentialDownload,true);
 assert(f.events.some(e=>e.phase==='downloading'&&e.percent===55));
 assert.equal(f.calls.filter(c=>c[0]==='download').length,1);assert(!f.calls.some(c=>c[0]==='deb'));
 await f.installer.install();assert.deepEqual(f.calls.slice(-2),[['flush'],['deb','/tmp/verified.deb']]);
 await assert.rejects(f.installer.install(),/Download an update first/);
});
test('unexpected versions, filenames, URLs, checksums, sizes and web installers are rejected',()=>{
 validateUpdateInfo(info(),target,'linux','x64','deb');
 const invalid=[{...info(),version:'0.6.0'},{...info(),packages:{}},{...info(),files:[]},
  ...[{url:'https://untrusted.example/file.deb'},{url:'../file.deb'},{url:'Harbor-0.5.0-win-x64.exe'},{sha512:'bad'},{size:0}].map(change=>({...info(),files:[{...file,...change}]}))];
 for(const entry of invalid)assert.throws(()=>validateUpdateInfo(entry,target,'linux','x64','deb'));
 assert.throws(()=>validateUpdateInfo(info(),target,'linux','x64','appimage'));
 const f=fixture();for(const value of [null,{...target,tag:'v../bad'},{version:'0.4.1',tag:'v0.4.1'},{version:'0.3.0',tag:'v0.3.0'}])assert.throws(()=>f.installer.download(value));
 assert.throws(()=>fixture({support:{supported:false,reason:'Manual only'}}).installer.download(target),/Manual only/);
});
test('metadata and checksum failures are retryable and cannot reach installation',async()=>{
 for(const failure of ['metadata','checksum']){
  const f=fixture();const create=f.installer.createUpdater;
  f.installer.createUpdater=()=>{const updater=create();if(failure==='metadata')updater.checkForUpdates=async()=>({updateInfo:{...info(),version:'9.0.0'}});else updater.downloadUpdate=async()=>{throw new Error('checksum mismatch: private path')};return updater};
  const state=await f.installer.download(target);assert.equal(state.phase,'error');assert(!state.error.includes('private path'));
  await assert.rejects(f.installer.install());assert(!f.calls.some(c=>c[0]==='deb'));if(failure==='metadata')assert(!f.calls.some(c=>c[0]==='download'));
  f.installer.createUpdater=create;assert.equal((await f.installer.download(target)).phase,'downloaded');
 }
});
test('cancellation ignores a late completed download and allows retry; dismiss does not install',async()=>{
 const f=fixture();let finish;const create=f.installer.createUpdater;
 f.installer.createUpdater=()=>{const u=create();u.downloadUpdate=()=>new Promise(resolve=>{finish=resolve});return u};
 const pending=f.installer.download(target);await new Promise(setImmediate);
 f.installer.cancel();finish(['/tmp/verified.deb']);assert.equal((await pending).phase,'idle');await assert.rejects(f.installer.install());
 f.installer.createUpdater=create;await f.installer.download(target);assert.equal(f.installer.discard().phase,'idle');await assert.rejects(f.installer.install());
});
test('installation failure keeps the verified update ready to retry and waits for outstanding writes',async()=>{
 let flush,attempts=0;const f=fixture({beforeInstall:()=>new Promise(resolve=>{flush=resolve}),installDeb:async()=>{if(++attempts===1)throw new Error('permission declined')}});
 await f.installer.download(target);const pending=f.installer.install();assert.equal(attempts,0);flush();await pending;
 assert.equal(f.installer.snapshot().phase,'downloaded');assert.match(f.installer.snapshot().error,/cancelled or failed/);
 const retry=f.installer.install();flush();await retry;assert.equal(attempts,2);
});
test('NSIS and AppImage explicitly install once and retain ready state on installer errors',async()=>{
 for(const [kind,platform,name] of [['nsis','win32','Harbor-0.5.0-win-x64.exe'],['appimage','linux','Harbor-0.5.0-linux-x86_64.AppImage']]){
  const f=fixture({support:{supported:true,kind},platform}),create=f.installer.createUpdater;
  f.installer.createUpdater=()=>{const u=create();u.checkForUpdates=async()=>({updateInfo:{version:target.version,files:[{...file,url:name}]}});return u};
  await f.installer.download(target);await f.installer.install();assert.deepEqual(f.calls.at(-1),['install',true,true]);
  f.updater.emit('error',new Error('failed'));assert.equal(f.installer.snapshot().phase,'downloaded');
 }
});
test('DEB updates invoke a single package operation with literal arguments and restart only on success',async()=>{
 const calls=[],app={relaunch:()=>calls.push('relaunch'),quit:()=>calls.push('quit')},file="/tmp/space and 'quotes'/update.deb";
 await installDeb(file,{getuid:()=>1000,execFile:async(...args)=>calls.push(args),app});
 assert.deepEqual(calls[0].slice(0,2),['/usr/bin/pkexec',['/usr/bin/dpkg','--install',file]]);assert.deepEqual(calls.slice(1),['relaunch','quit']);
 calls.length=0;
 await assert.rejects(installDeb(file,{getuid:()=>1000,execFile:async()=>{throw new Error('denied')},app}));assert.deepEqual(calls,[]);
 await installDeb(file,{getuid:()=>0,execFile:async(...args)=>calls.push(args),app});assert.equal(calls[0][0],'/usr/bin/dpkg');
});
test('checks and release channel changes cannot replace an active update',async()=>{
 const checker=new UpdateChecker({dir:'/unused',version:'0.4.1',platform:'linux',arch:'x64',fetchImpl:async()=>{throw new Error('Must not check')}});
 const f=fixture();checker.installer=f.installer;await f.installer.download(target);
 assert.equal((await checker.check()).installation.phase,'downloaded');
 await assert.rejects(checker.configure({includePreviews:true}),/current update/);checker.stop();
});

test('real updater reads the release feed, downloads bytes and rejects a corrupted payload',async t=>{
 const previousArch=process.env.TEST_UPDATER_ARCH;process.env.TEST_UPDATER_ARCH='x64';
 t.after(()=>{if(previousArch===undefined)delete process.env.TEST_UPDATER_ARCH;else process.env.TEST_UPDATER_ARCH=previousArch});
 const http=require('node:http');
 const {DebUpdater,CancellationToken}=require('electron-updater');
 const {ElectronHttpExecutor}=require('electron-updater/out/electronHttpExecutor');
 const bytes=Buffer.from('Synthetic installer bytes, never executable.');
 const manifest={version:target.version,files:[{url:file.url,size:bytes.length,sha512:createHash('sha512').update(bytes).digest('base64')}]};
 let corrupt=false;const requests=[];
 const server=http.createServer((req,res)=>{
  requests.push(req.url.split('?')[0]);
  if(req.url.startsWith('/latest-linux.yml'))res.end(JSON.stringify(manifest));
  else if(req.url==='/'+file.url)res.end(corrupt?Buffer.from('Corrupted payload'):bytes);
  else {res.statusCode=404;res.end()}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const damaged of [false,true]){
  corrupt=damaged;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-real-updater-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const config=path.join(dir,'app-update.yml');await fs.writeFile(config,JSON.stringify({updaterCacheDirName:'updates'}));
  const app={version:'0.4.1',name:'Harbor test',isPackaged:true,userDataPath:dir,baseCachePath:dir,appUpdateConfigPath:config,whenReady:async()=>{},onQuit:()=>assert.fail('Must not install on quit')};
  const f=fixture({createToken:()=>new CancellationToken(),createUpdater:()=>{
   const updater=new DebUpdater(null,app),executor=new ElectronHttpExecutor();
   // Use Node's local HTTP transport but the real updater's download/checksum
   // pipeline. Production always uses Electron's isolated network session.
   executor.createRequest=(options,callback)=>http.request(options,callback);
   updater.httpExecutor=executor;updater._testOnlyOptions={platform:'linux'};
   const setFeedURL=updater.setFeedURL.bind(updater);
   updater.setFeedURL=options=>{assert.equal(options.url,RELEASES_URL+'/download/v0.5.0/');setFeedURL({...options,url:`http://127.0.0.1:${server.address().port}/`})};
   return updater;
  }});
  const state=await f.installer.download(target);
  assert.equal(state.phase,damaged?'error':'downloaded');
  if(damaged)await assert.rejects(f.installer.install());
  else assert.deepEqual(await fs.readFile(f.installer.downloadedFile),bytes);
 }
 assert.deepEqual(requests,['/latest-linux.yml','/'+file.url,'/latest-linux.yml','/'+file.url]);
});
