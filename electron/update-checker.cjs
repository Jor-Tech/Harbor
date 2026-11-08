'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const semver=require('semver');
const {RELEASES_URL,REPOSITORY}=require('./releases.cjs');
const API_URL=`https://api.github.com/repos/${REPOSITORY}/releases`;
const INTERVAL=12*60*60_000,COOLDOWN=60_000,MAX_BODY=4*1024*1024;

function preferences(value={},version='') {
 return {automatic:value.automatic===true,includePreviews:typeof value.includePreviews==='boolean'?value.includePreviews:!!semver.prerelease(version)};
}
function installerNames(version,platform,arch) {
 if(platform==='darwin'&&['x64','arm64'].includes(arch))return [`Harbor-${version}-mac-${arch}.dmg`,`Harbor-${version}-mac-${arch}.zip`];
 if(platform==='win32'&&arch==='x64')return [`Harbor-${version}-win-x64.exe`];
 if(platform==='linux'&&arch==='x64')return [`Harbor-${version}-linux-amd64.deb`,`Harbor-${version}-linux-x86_64.AppImage`];
 return [];
}
function latestRelease(releases,{version,platform,arch,includePreviews}) {
 if(!semver.valid(version))throw new Error('The installed version cannot be compared. Open releases & downloads.');
 const valid=[];
 for(const r of releases){
  if(!r||r.draft!==false||typeof r.tag_name!=='string'||r.tag_name.length>100||!r.tag_name.startsWith('v')||!Number.isFinite(Date.parse(r.published_at)))continue;
  const v=r.tag_name.slice(1);if(!semver.valid(v))continue;
  if(!includePreviews&&(r.prerelease===true||semver.prerelease(v)))continue;
  const names=installerNames(v,platform,arch);
  if(!Array.isArray(r.assets)||!r.assets.some(a=>names.includes(a?.name)&&a.state==='uploaded'&&Number.isSafeInteger(a.size)&&a.size>0))continue;
  // Never trust links or HTML supplied by the API. Open only our fixed repository.
  valid.push({version:v,tag:r.tag_name,url:`${RELEASES_URL}/tag/${encodeURIComponent(r.tag_name)}`,publishedAt:r.published_at});
 }
 return valid.sort((a,b)=>semver.rcompare(a.version,b.version))[0]||null;
}
class UpdateError extends Error {constructor(message,retryAt=0){super(message);this.retryAt=retryAt}}
async function readJson(response) {
 if(Number(response.headers.get('content-length'))>MAX_BODY)throw new Error('Release information is too large.');
 if(!response.body)throw new Error('Empty release response.');
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BODY)throw new Error('Release information is too large.');chunks.push(Buffer.from(value));}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(data)||data.length>100)throw new Error('Invalid release information.');return data;
}
async function fetchReleases({signal,fetchImpl=(...args)=>globalThis.fetch(...args),now=Date.now}) {
 const releases=[];
 for(let page=1;page<=3;page++){
  const response=await fetchImpl(`${API_URL}?per_page=100&page=${page}`,{method:'GET',redirect:'error',credentials:'omit',signal,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Harbor-update-check'}});
  if(response.status===404)throw new UpdateError('Public release information is not available. The repository may still be private. Use View releases & downloads.');
  if(response.status===403||response.status===429){
   const retry=response.headers.get('retry-after'),seconds=Number(retry),retryAt=retry?(Number.isFinite(seconds)?now()+Math.max(0,seconds)*1000:Date.parse(retry)):0;
   const reset=Number(response.headers.get('x-ratelimit-reset'))*1000;
   throw new UpdateError('GitHub is limiting update checks. Please try again later.',Math.max(now()+COOLDOWN,Number.isFinite(retryAt)?retryAt:0,Number.isFinite(reset)?reset:0));
  }
  if(!response.ok)throw new UpdateError('GitHub could not provide release information. Please try again later.');
  const entries=await readJson(response);releases.push(...entries);if(entries.length<100)return releases;
 }
 throw new UpdateError('The release list is too long to check completely. Use View releases & downloads.');
}
class UpdateChecker {
 constructor({dir,version,platform,arch,emit=()=>{},fetchImpl,now=Date.now,schedule=setTimeout,unschedule=clearTimeout}) {
  Object.assign(this,{dir,version,platform,arch,emit,fetchImpl,now,schedule,unschedule});
  this.preferences=preferences({},version);this.state={phase:'idle',lastChecked:null,latest:null,error:''};this.epoch=0;this.nextAllowed=0;this.inflight=null;this.releases=null;
 }
 snapshot(){return {...this.state,preferences:{...this.preferences},...(this.installer?{installation:this.installer.snapshot()}: {})}}
 changed(){this.emit(this.snapshot());return this.snapshot()}
 async load(){try{this.preferences=preferences(JSON.parse(await fs.readFile(path.join(this.dir,'updates.json'),'utf8')),this.version)}catch{}return this.snapshot()}
 start(){this.arm(30_000)}
 arm(delay=INTERVAL){this.unschedule(this.timer);if(this.preferences.automatic){this.timer=this.schedule(()=>{this.timer=null;void this.check()},Math.min(delay,2**31-1));this.timer.unref?.()}}
 stop(){this.unschedule(this.timer);this.timer=null;++this.epoch;this.controller?.abort();this.inflight=null}
 async configure(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||Object.keys(value).some(k=>!['automatic','includePreviews'].includes(k)||typeof value[k]!=='boolean'))throw new Error('Invalid update preferences.');
  if(this.installer?.active&&'includePreviews' in value)throw new Error('Finish or dismiss the current update before changing release channel.');
  const next={...this.preferences,...value},file=path.join(this.dir,'updates.json'),temp=file+'.'+randomUUID()+'.tmp';
  try{await fs.mkdir(this.dir,{recursive:true});await fs.writeFile(temp,JSON.stringify(next),{mode:0o600,flag:'wx'});await fs.rename(temp,file)}finally{await fs.rm(temp,{force:true})}
  this.stop();this.preferences=next;
  if(this.releases)this.select();else this.state={phase:'idle',lastChecked:null,latest:null,error:''};
  this.arm(30_000);return this.changed();
 }
 select(){const latest=latestRelease(this.releases,{version:this.version,platform:this.platform,arch:this.arch,...this.preferences});this.state={phase:!latest?'empty':semver.gt(latest.version,this.version)?'available':'current',latest,lastChecked:this.state.lastChecked,error:''}}
 check(){
  if(this.installer?.active){this.arm();return Promise.resolve(this.snapshot())}
  if(this.inflight)return this.inflight;
  if(this.now()<this.nextAllowed){this.arm(Math.max(INTERVAL,this.nextAllowed-this.now()));return Promise.resolve(this.snapshot())}
  const epoch=this.epoch,controller=new AbortController();this.controller=controller;this.nextAllowed=this.now()+COOLDOWN;
  this.state={...this.state,phase:'checking',error:''};this.changed();
  const timeout=this.schedule(()=>controller.abort(),15_000);timeout.unref?.();
  const run=async()=>{try{
   const releases=await fetchReleases({signal:controller.signal,fetchImpl:this.fetchImpl,now:this.now});if(epoch!==this.epoch)return this.snapshot();
   this.releases=releases;this.state.lastChecked=this.now();this.select();
  }catch(error){if(epoch!==this.epoch)return this.snapshot();this.nextAllowed=Math.max(this.nextAllowed,error.retryAt||0);this.state={...this.state,phase:'error',error:error instanceof UpdateError?error.message:'Could not check for updates. Check your connection and try again.',latest:null};}
  finally{this.unschedule(timeout);if(epoch===this.epoch){this.inflight=null;this.controller=null;this.arm(Math.max(INTERVAL,this.nextAllowed-this.now()))}}
  return this.changed();};
  this.inflight=run();return this.inflight;
 }
}
module.exports={UpdateChecker,latestRelease,fetchReleases,preferences,installerNames,API_URL,INTERVAL};
