'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const semver=require('semver');
const {RELEASES_URL}=require('./releases.cjs');
const {installerNames}=require('./update-checker.cjs');

// Only installed formats that can replace themselves are enabled. The current
// macOS releases are ad-hoc signed; Squirrel requires a publisher signature.
async function installationSupport({packaged,platform,arch,resourcesPath,appImage}) {
 if(!packaged)return {supported:false,reason:'Direct updates are available in the installed app.'};
 if(platform==='darwin')return {supported:false,reason:'This macOS build requires a manual update. Use View releases & downloads.'};
 if(arch==='x64'){
  if(platform==='win32')return {supported:true,kind:'nsis'};
  if(platform==='linux'){
   if(appImage&&path.isAbsolute(appImage))return {supported:true,kind:'appimage'};
   try{if((await fs.readFile(path.join(resourcesPath,'package-type'),'utf8')).trim()==='deb')return {supported:true,kind:'deb'}}catch{}
  }
 }
 return {supported:false,reason:'Use View releases & downloads to update this installation.'};
}

function validateUpdateInfo(info,target,platform,arch,kind) {
 const names=installerNames(target.version,platform,arch);
 const extension={nsis:'.exe',appimage:'.AppImage',deb:'.deb'}[kind];
 if(!info||info.version!==target.version||!Array.isArray(info.files)||!info.files.length||info.files.length>names.length||info.packages)throw new Error('Unexpected update metadata.');
 const seen=new Set();
 for(const file of info.files){
  if(!names.includes(file.url)||seen.has(file.url)||!Number.isSafeInteger(file.size)||file.size<=0||typeof file.sha512!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(file.sha512))throw new Error('Invalid update file.');
  seen.add(file.url);
 }
 if(![...seen].some(name=>name.endsWith(extension)))throw new Error('No compatible update file.');
}

class UpdateInstaller {
 constructor({support,version,platform,arch,createUpdater,createToken,emit=()=>{},beforeInstall=async()=>{},installDeb}) {
  Object.assign(this,{support,version,platform,arch,createUpdater,createToken,emit,beforeInstall,installDeb});
  this.state={phase:'idle',version:null,percent:0,error:''};
 }
 snapshot(){return {...this.state,...this.support}}
 get active(){return ['preparing','downloading','downloaded','installing'].includes(this.state.phase)}
 changed(patch){Object.assign(this.state,patch);this.emit();return this.snapshot()}
 download(target){
  if(this.pending)return this.pending;
  if(!this.support.supported)throw new Error(this.support.reason);
  if(this.active)throw new Error('An update is already in progress.');
  if(!target||!semver.valid(target.version)||!semver.gt(target.version,this.version)||target.tag!==`v${target.version}`)throw new Error('Check for an available update first.');
  this.changed({phase:'preparing',version:target.version,percent:0,error:''});
  // Pin the feed to the exact release selected by the existing channel checker.
  // No URL, path, channel or version is accepted from the renderer.
  this.pending=this.runDownload({...target}).finally(()=>{this.pending=null});
  return this.pending;
 }
 async runDownload(target){
  try{
   const updater=this.createUpdater(this.support.kind);this.updater=updater;
   updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.autoRunAppAfterInstall=true;
   updater.allowPrerelease=true;updater.allowDowngrade=false;
   updater.disableDifferentialDownload=true;updater.disableWebInstaller=true;
   updater.logger=null;
   updater.setFeedURL({provider:'generic',url:`${RELEASES_URL}/download/${encodeURIComponent(target.tag)}/`,channel:'latest',useMultipleRangeRequest:false});
   updater.on('error',()=>{
    if(this.state.phase==='installing')this.changed({phase:'downloaded',error:'Could not install the update. Try again or use View releases & downloads.'});
   });
   updater.on('download-progress',progress=>{
    if(this.state.phase==='downloading'&&Number.isFinite(progress.percent))this.changed({percent:Math.max(0,Math.min(100,Math.floor(progress.percent)))});
   });
   const result=await updater.checkForUpdates();
   validateUpdateInfo(result?.updateInfo,target,this.platform,this.arch,this.support.kind);
   this.token=this.createToken();
   this.changed({phase:'downloading'});
   const files=await updater.downloadUpdate(this.token);
   if(this.token.cancelled){this.changed({phase:'idle',version:null,percent:0,error:''});return this.snapshot()}
   if(!Array.isArray(files)||!files.length)throw new Error('No verified download.');
   this.downloadedFile=files[0];
   return this.changed({phase:'downloaded',percent:100,error:''});
  }catch(error){
   if(this.token?.cancelled)return this.changed({phase:'idle',version:null,percent:0,error:''});
   return this.changed({phase:'error',error:'Could not download or verify the update. Check your connection and free disk space, then try again. This release may require a manual download.'});
  }finally{this.token=null}
 }
 cancel(){if(this.state.phase==='downloading')this.token?.cancel();return this.snapshot()}
 discard(){
  if(!['downloaded','error'].includes(this.state.phase))throw new Error('The update cannot be dismissed yet.');
  this.updater=null;this.downloadedFile=null;
  return this.changed({phase:'idle',version:null,percent:0,error:''});
 }
 async install(){
  if(this.state.phase!=='downloaded'||!this.updater)throw new Error('Download an update first.');
  this.changed({phase:'installing',error:''});
  try{
   await this.beforeInstall();
   if(this.support.kind==='deb')await this.installDeb(this.downloadedFile);
   else this.updater.quitAndInstall(true,true);
  }catch{this.changed({phase:'downloaded',error:'Installation was cancelled or failed. Try again or use View releases & downloads.'})}
  return this.snapshot();
 }
 stop(){this.token?.cancel()}
}

// Keep elevation explicit and asynchronous. Unlike a package-repair fallback,
// failure/cancellation must never claim that the new version was installed.
async function installDeb(file,{execFile,app,getuid=process.getuid}) {
 const command=getuid?.()===0?'/usr/bin/dpkg':'/usr/bin/pkexec';
 const args=command.endsWith('pkexec')?['/usr/bin/dpkg','--install',file]:['--install',file];
 await execFile(command,args,{timeout:10*60_000});
 app.relaunch();app.quit();
}

module.exports={UpdateInstaller,installationSupport,validateUpdateInfo,installDeb};
