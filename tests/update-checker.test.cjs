'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {UpdateChecker,latestRelease,fetchReleases,preferences,API_URL,INTERVAL}=require('../electron/update-checker.cjs');
const {RELEASES_URL}=require('../electron/releases.cjs');
const base={version:'0.4.0-alpha.12',platform:'linux',arch:'x64',includePreviews:true};
function release(version,extra={}){return {tag_name:'v'+version,draft:false,prerelease:version.includes('-'),published_at:'2026-10-30T10:00:00Z',html_url:'https://untrusted.example',assets:[{name:`Harbor-${version}-linux-amd64.deb`,state:'uploaded',size:100}],...extra}}
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});
async function fixture(t,extra={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-update-test-'));let now=100000,calls=0;const scheduled=[];const checker=new UpdateChecker({dir,...base,now:()=>now,fetchImpl:async()=>{calls++;return response([release('0.4.0-alpha.13')])},schedule:(fn,ms)=>{const timer={fn,ms,unref(){}};scheduled.push(timer);return timer},unschedule:timer=>{if(timer)timer.cancelled=true},...extra});t.after(async()=>{checker.stop();await fs.rm(dir,{recursive:true,force:true})});return {checker,dir,scheduled,calls:()=>calls,advance:ms=>{now+=ms}}}

test('semantic ordering handles alpha.9/alpha.12, stable releases and channel filtering',()=>{
 const rows=[release('0.4.0-alpha.9'),release('0.4.0-alpha.13'),release('0.3.0'),release('0.5.0-beta.1')];
 assert.equal(latestRelease(rows,base).version,'0.5.0-beta.1');
 assert.equal(latestRelease(rows,{...base,includePreviews:false}).version,'0.3.0');
 assert.equal(latestRelease([...rows,release('0.5.0')],base).version,'0.5.0');
 assert.equal(latestRelease([release('0.4.0-alpha.9'),release('0.4.0-alpha.12')],base).version,'0.4.0-alpha.12');
});
test('only published compatible releases with an uploaded installer qualify; URLs are constructed locally',()=>{
 const good=release('0.5.0');
 const rows=[release('99.0.0',{draft:true}),release('98.0.0',{published_at:null}),release('97.0.0',{assets:[]}),release('96.0.0',{assets:[{name:'other.exe',state:'uploaded',size:1}]}),release('95.0.0',{tag_name:'v../../bad'}),good];
 assert.equal(latestRelease(rows,base).url,RELEASES_URL+'/tag/v0.5.0');
 assert.equal(latestRelease([good],{...base,platform:'darwin',arch:'arm64'}),null);
 const arm=release('0.5.0',{assets:[{name:'Harbor-0.5.0-mac-arm64.dmg',state:'uploaded',size:22}]});
 assert.equal(latestRelease([arm],{...base,platform:'darwin',arch:'arm64'}).version,'0.5.0');
 assert.equal(latestRelease([release('0.5.0',{prerelease:true})],{...base,includePreviews:false}),null);
});
test('preferences default to no automatic network access and follow the installed release channel',()=>{
 assert.deepEqual(preferences({},base.version),{automatic:false,includePreviews:true});
 assert.deepEqual(preferences({automatic:'yes',includePreviews:'yes'},'1.0.0'),{automatic:false,includePreviews:false});
});
test('network requests use only the fixed public endpoint, no credentials, and no redirects',async()=>{
 const calls=[];const rows=await fetchReleases({fetchImpl:async(url,options)=>{calls.push({url,options});return response([])}});
 assert.deepEqual(rows,[]);assert.equal(calls[0].url,API_URL+'?per_page=100&page=1');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'omit');assert(!('Authorization' in calls[0].options.headers));
});
test('pagination checks later releases and refuses to claim current when the list is truncated',async()=>{
 let page=0;const rows=await fetchReleases({fetchImpl:async()=>response(++page===1?Array.from({length:100},()=>release('0.1.0')):[release('0.5.0')])});assert.equal(rows.length,101);assert.equal(latestRelease(rows,base).version,'0.5.0');
 await assert.rejects(fetchReleases({fetchImpl:async()=>response(Array(100).fill(release('0.1.0')))}),/too long/);
});
test('private repository, malformed payload and oversized responses never report up to date',async()=>{
 await assert.rejects(fetchReleases({fetchImpl:async()=>response({},404)}),/may still be private/);
 await assert.rejects(fetchReleases({fetchImpl:async()=>response({unexpected:true})}),/Invalid/);
 await assert.rejects(fetchReleases({fetchImpl:async()=>response([] ,200,{'content-length':5*1024*1024})}),/too large/);
 await assert.rejects(fetchReleases({fetchImpl:async()=>new Response(' '.repeat(4*1024*1024+1))}),/too large/);
});
test('manual checks work while automatic checks are off; concurrent/repeated checks share the result',async t=>{
 const f=await fixture(t);await f.checker.load();f.checker.start();assert.equal(f.scheduled.length,0);assert.equal(f.calls(),0);
 const first=f.checker.check(),second=f.checker.check();assert.equal(first,second);assert.equal((await first).phase,'available');assert.equal(f.calls(),1);
 await f.checker.check();assert.equal(f.calls(),1);f.advance(60001);await f.checker.check();assert.equal(f.calls(),2);
});
test('settings persist separately from the vault and scheduling stops when opted out',async t=>{
 const f=await fixture(t);await f.checker.configure({automatic:true,includePreviews:false});assert(f.scheduled.some(x=>x.ms===30000&&!x.cancelled));assert.equal(f.calls(),0);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dir,'updates.json'),'utf8')),{automatic:true,includePreviews:false});
 const other=new UpdateChecker({dir:f.dir,...base});assert.equal((await other.load()).preferences.automatic,true);other.stop();
 await f.checker.check();assert.equal(f.checker.snapshot().phase,'empty');assert(f.scheduled.some(x=>x.ms===INTERVAL&&!x.cancelled));
 await f.checker.configure({automatic:false});assert(f.scheduled.every(x=>x.cancelled));
 await assert.rejects(f.checker.configure({automatic:'true'}));await assert.rejects(f.checker.configure({url:'https://untrusted.example'}));
});
test('a disabled automatic setting cancels an in-flight request and ignores its late response',async t=>{
 let finish,signal;const f=await fixture(t,{fetchImpl:async(_url,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve})}});
 await f.checker.configure({automatic:true});const pending=f.checker.check();await f.checker.configure({automatic:false});assert(signal.aborted);finish(response([release('99.0.0')]));await pending;assert.equal(f.checker.snapshot().phase,'idle');assert.equal(f.checker.snapshot().latest,null);
});
test('rate limits prevent retries until Retry-After, without suppressing later checks',async t=>{
 let calls=0;const f=await fixture(t,{fetchImpl:async()=>{calls++;return response({},429,{'retry-after':'120'})}});
 assert.equal((await f.checker.check()).phase,'error');f.advance(60001);await f.checker.check();assert.equal(calls,1);f.advance(60001);await f.checker.check();assert.equal(calls,2);
});
test('an older compatible version is current, no matching release is empty, network failure is an error',async t=>{
 for(const [rows,phase] of [[[release('0.4.0-alpha.9')],'current'],[[],'empty']]){const f=await fixture(t,{fetchImpl:async()=>response(rows)});assert.equal((await f.checker.check()).phase,phase)}
 const f=await fixture(t,{fetchImpl:async()=>{throw new Error('private network detail')}});const state=await f.checker.check();assert.equal(state.phase,'error');assert(!state.error.includes('private network detail'));assert.equal(state.lastChecked,null);
});
test('changing preview preference reselects the cached result without another request',async t=>{
 const f=await fixture(t);await f.checker.check();assert.equal(f.checker.snapshot().phase,'available');await f.checker.configure({includePreviews:false});assert.equal(f.checker.snapshot().phase,'empty');assert.equal(f.calls(),1);
});
test('automatic startup invokes a check, recurring work is scheduled, and timeouts abort safely',async t=>{
 const f=await fixture(t);await f.checker.configure({automatic:true});f.scheduled.find(x=>x.ms===30000&&!x.cancelled).fn();await f.checker.inflight;assert.equal(f.calls(),1);assert.equal(f.checker.snapshot().phase,'available');assert(f.scheduled.some(x=>x.ms===INTERVAL&&!x.cancelled));
 const stalled=await fixture(t,{fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))});const pending=stalled.checker.check();stalled.scheduled.find(x=>x.ms===15000&&!x.cancelled).fn();assert.equal((await pending).phase,'error');
});
test('very long Retry-After values never overflow the automatic timer',async t=>{
 const f=await fixture(t,{fetchImpl:async()=>response({},429,{'retry-after':'9999999999'})});await f.checker.configure({automatic:true});await f.checker.check();assert.equal(f.scheduled.at(-1).ms,2**31-1);
});
