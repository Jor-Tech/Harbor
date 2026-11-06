'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ConnectionManager} = require('../electron/connections.cjs');
const {TerminalSessions} = require('../electron/terminal-sessions.cjs');
const {AuthPrompts} = require('../electron/auth-prompts.cjs');
const {createTerminalServer} = require('./helpers/terminal-server.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<250;i++){if(fn())return;await sleep(10)}assert.fail('Timed out waiting for terminal state')}
async function fixture(t,options={}){
 const server=await createTerminalServer(options),events=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,emit:(name,event)=>events.push({name,...event})});
 const prompts=new AuthPrompts((name,event)=>manager.emit(name,event));manager.requestAuth=(...args)=>prompts.request(...args);
 let reads=0;
 const tabs=new TerminalSessions(manager,async()=>{reads++;return {host:server.host,credential:server.credential,route:[]}}, {delays:[20,20,20,20,20]});
 t.after(async()=>{manager.closeAll();prompts.cancelAll();await server.close()});
 return {server,events,manager,tabs,prompts,reads:()=>reads};
}
test('manual reconnect preserves tab ID, uses fresh credentials, and does not replay input',async t=>{
 const f=await fixture(t);const tab=await f.tabs.open({hostId:'host'});
 f.manager.write(tab.id,'once-only');await until(()=>f.server.received.includes('once-only'));
 f.server.drop();await until(()=>f.tabs.get(tab.id).status==='closed');
 assert.equal(f.tabs.get(tab.id).autoReconnect,false);assert.equal(f.reads(),1);
 assert.throws(()=>f.manager.write(tab.id,'offline-input'),/closed/);
 await f.tabs.reconnect(tab.id);
 assert.equal(f.tabs.get(tab.id).status,'connected');assert.equal(f.reads(),2);assert.equal(f.tabs.tabs.size,1);
 assert.equal(f.server.received.join(''),'once-only');
 assert(f.events.some(e=>e.data?.includes('previous commands are not replayed')));
 f.manager.resize(tab.id,132,42);await until(()=>f.server.sizes.length>0);
});
test('opt-in reconnect recovers a transport loss with the same tab',async t=>{
 const f=await fixture(t);const tab=await f.tabs.open({});f.tabs.setAutoReconnect(tab.id,true);f.server.drop();
 await until(()=>f.reads()===2&&f.tabs.get(tab.id).status==='connected');
 assert(f.events.some(e=>e.status==='waiting'));assert.equal(f.server.state.connections,2);
});
test('normal remote shell exit never reconnects, even when enabled',async t=>{
 const f=await fixture(t);const tab=await f.tabs.open({});f.tabs.setAutoReconnect(tab.id,true);f.server.exit();
 await until(()=>f.tabs.get(tab.id).status==='closed');await sleep(100);
 assert.equal(f.reads(),1);assert.equal(f.tabs.get(tab.id).event.reason,'exit');
});
test('automatic retries are bounded and a manual attempt resets the budget',async t=>{
 const f=await fixture(t);const tab=await f.tabs.open({});f.tabs.setAutoReconnect(tab.id,true);
 const original=f.manager.connect.bind(f.manager);
 f.manager.connect=async(_h,_c,_r,id)=>{const e=new Error('Connection refused');e.code='ECONNREFUSED';f.manager.emit('terminal:status',{id,status:'error',error:e.message,retryable:true});throw e};
 f.server.drop();await until(()=>f.tabs.get(tab.id).event.exhausted);
 assert.equal(f.reads(),6);await sleep(60);assert.equal(f.reads(),6);
 f.manager.connect=original;await f.tabs.reconnect(tab.id);assert.equal(f.tabs.get(tab.id).status,'connected');assert.equal(f.tabs.get(tab.id).attempt,0);
});
test('cancel, disable, close and vault lock cancel scheduled reconnects',async t=>{
 for(const action of ['cancel','disable','close','lock']){
  const f=await fixture(t);f.tabs.delays=[100];const tab=await f.tabs.open({});f.tabs.setAutoReconnect(tab.id,true);f.server.drop();await until(()=>f.tabs.get(tab.id).status==='waiting');
  if(action==='disable')f.tabs.setAutoReconnect(tab.id,false);else if(action==='lock')f.manager.closeAll();else f.tabs[action](tab.id);
  await sleep(150);assert.equal(f.reads(),1,action);assert.equal(f.manager.sessions.size,0);
  if(['close','lock'].includes(action))assert.equal(f.tabs.tabs.size,0);
 }
});
test('MFA approval repeats and Cancel reconnect aborts an in-flight challenge',async t=>{
 const f=await fixture(t,{otp:true});
 const initial=f.tabs.open({});await until(()=>f.prompts.pending.size);f.prompts.answer([...f.prompts.pending.keys()][0],['123456']);const tab=await initial;
 f.tabs.setAutoReconnect(tab.id,true);f.server.drop();await until(()=>f.prompts.pending.size);
 assert.equal(f.tabs.get(tab.id).status,'authenticating');f.prompts.answer([...f.prompts.pending.keys()][0],['123456']);await until(()=>f.tabs.get(tab.id).status==='connected');
 f.server.drop();await until(()=>f.prompts.pending.size);f.tabs.cancel(tab.id);await until(()=>!f.tabs.get(tab.id).pending);await sleep(100);
 assert.equal(f.prompts.pending.size,0);assert.equal(f.manager.sessions.size,0);assert.equal(f.reads(),3);
});
test('cancelled authentication and host-key rejection require a manual retry',async t=>{
 for(const mode of ['cancel-auth','host-key','credentials']){
  const f=await fixture(t);const tab=await f.tabs.open({});f.tabs.setAutoReconnect(tab.id,true);
  if(mode==='cancel-auth')f.server.state.otp=true;
  if(mode==='host-key')f.manager.verifyHost=async()=>false;
  if(mode==='credentials')f.server.state.reject=true;
  f.server.drop();
  if(mode==='cancel-auth'){await until(()=>f.prompts.pending.size);f.prompts.answer([...f.prompts.pending.keys()][0],null)}
  await until(()=>f.tabs.get(tab.id).status==='error');await sleep(100);assert.equal(f.reads(),2,mode);
 }
});
test('deleted host stops retries; closing during vault resolution cannot start a late connection',async t=>{
 const f=await fixture(t);const tab=await f.tabs.open({});f.tabs.setAutoReconnect(tab.id,true);
 f.tabs.resolve=async()=>{throw new Error('Host no longer exists')};f.server.drop();await until(()=>f.tabs.get(tab.id).status==='error');assert.match(f.tabs.get(tab.id).event.error,/no longer exists/);
 let finish;f.tabs.resolve=()=>new Promise(r=>{finish=r});const reconnect=f.tabs.reconnect(tab.id);assert.throws(()=>f.tabs.reconnect(tab.id),/already/);
 f.manager.closeAll();finish({host:f.server.host,credential:f.server.credential});await reconnect;assert.equal(f.manager.sessions.size,0);assert.equal(f.tabs.tabs.size,0);assert.equal(f.server.state.connections,1);
});
test('reconnect rebuilds a jump route and authenticates each hop again',async t=>{
 const {createRoutingServer}=require('./helpers/routing-server.cjs');
 const jump=await createRoutingServer(),target=await createTerminalServer();
 const manager=new ConnectionManager({verifyHost:async()=>true});
 const tabs=new TerminalSessions(manager,async()=>({host:target.host,credential:target.credential,route:[{host:jump.host,credential:jump.credential}]}),{delays:[20]});
 t.after(async()=>{manager.closeAll();await target.close();await jump.close()});
 const tab=await tabs.open({});tabs.setAutoReconnect(tab.id,true);for(const c of jump.clients)c.end();
 await until(()=>target.state.connections===2&&tabs.get(tab.id).status==='connected');
 assert.equal(jump.forwardRequests.length,2);assert.equal(jump.authAttempts.filter(a=>a.method==='password').length,2);
});
test('lock during reconnect MFA cancels prompts and cannot resurrect the tab',async t=>{
 const f=await fixture(t);const tab=await f.tabs.open({});f.tabs.setAutoReconnect(tab.id,true);f.server.state.otp=true;f.server.drop();await until(()=>f.prompts.pending.size);
 f.manager.closeAll();await until(()=>f.prompts.pending.size===0);await sleep(100);assert.equal(f.tabs.tabs.size,0);assert.equal(f.manager.sessions.size,0);assert.equal(f.reads(),2);
});
test('a stable connection earns a new automatic retry budget',async t=>{
 const f=await fixture(t);const tab=await f.tabs.open({});f.tabs.setAutoReconnect(tab.id,true);const state=f.tabs.get(tab.id);state.attempt=5;state.connectedAt=Date.now()-61000;
 f.server.drop();await until(()=>f.reads()===2&&state.status==='connected');assert.equal(state.attempt,1);
});

test('persistent terminals keep independent remote identities through reconnect and workspace restore',async t=>{
 const f=await fixture(t);f.server.host.persistentSession=true;
 const a=await f.tabs.open({hostId:'host'}),b=await f.tabs.open({hostId:'host'});
 assert.notEqual(a.sessionRef,b.sessionRef);assert.equal(f.server.state.persistent.size,2);
 f.manager.write(a.id,'once');await until(()=>f.server.received.includes('once'));
 f.server.drop();await until(()=>f.tabs.get(a.id).status==='closed');await f.tabs.reconnect(a.id);
 assert.equal(f.tabs.get(a.id).sessionRef,a.sessionRef);assert.equal(f.server.state.persistent.size,2);
 assert.deepEqual(f.server.state.persistent.get(a.sessionRef).input,['once']);
 const {template,leaf}=await import('../src/layout.mjs');
 const workspace=template(leaf(a.id),[{...a,hostId:'host'}]);assert.equal(workspace.sessionRef,a.sessionRef);
 f.tabs.close(a.id);const restored=await f.tabs.open({hostId:workspace.hostId,sessionRef:workspace.sessionRef});
 assert.equal(restored.sessionRef,a.sessionRef);assert.notEqual(restored.id,a.id);
 f.tabs.cancel(restored.id);assert(f.server.state.persistent.has(a.sessionRef));
 await f.tabs.reconnect(restored.id);await f.tabs.terminate(restored.id);
 assert.equal(f.tabs.get(restored.id).event.reason,'ended');assert(!f.server.state.persistent.has(a.sessionRef));assert(f.server.state.persistent.has(b.sessionRef));
 f.manager.closeAll();assert(f.server.state.persistent.has(b.sessionRef));assert.equal(f.tabs.tabs.size,0);
});
test('missing tmux fails explicitly without a shell fallback or installation',async t=>{
 const f=await fixture(t,{tmux:false});f.server.host.persistentSession=true;
 await assert.rejects(f.tabs.open({}),/tmux is unavailable/);
 assert.deepEqual(f.server.state.commands,['command -v tmux >/dev/null 2>&1']);assert.equal(f.tabs.tabs.size,0);assert.equal(f.manager.sessions.size,0);
});
test('persistent references are validated and disabling the host option does not silently lose a saved session',async t=>{
 const f=await fixture(t);const {validateWorkspace}=require('../electron/host-model.cjs');
 for(const value of ["bad'; touch /tmp/no",'',42,'other-session']){
  await assert.rejects(f.tabs.open({sessionRef:value}),/Invalid persistent/);
  assert.throws(()=>validateWorkspace({layout:{type:'pane',id:'p',hostId:'host',sessionRef:value}}),/Invalid persistent/);
 }
 assert.equal(f.server.state.connections,0);f.server.host.persistentSession=true;
 const tab=await f.tabs.open({});f.tabs.cancel(tab.id);f.server.host.persistentSession=false;
 await f.tabs.reconnect(tab.id);assert.match(f.tabs.get(tab.id).event.error,/Enable persistent/);assert.equal(f.server.state.connections,1);
});
test('persistent reconnect still enforces MFA, host verification and lock cancellation',async t=>{
 const f=await fixture(t);f.server.host.persistentSession=true;const tab=await f.tabs.open({});
 f.server.drop();await until(()=>f.tabs.get(tab.id).status==='closed');f.manager.verifyHost=async()=>false;
 await f.tabs.reconnect(tab.id);assert.equal(f.tabs.get(tab.id).status,'error');assert.equal(f.server.state.commands.length,2);
 f.manager.verifyHost=async()=>true;f.server.state.otp=true;
 const retry=f.tabs.reconnect(tab.id);await until(()=>f.prompts.pending.size);
 f.manager.closeAll();await retry;assert.equal(f.prompts.pending.size,0);assert.equal(f.tabs.tabs.size,0);assert.equal(f.server.state.commands.length,2);
 assert(f.server.state.persistent.has(tab.sessionRef));
});

test('automatic persistent reconnect preserves identity and never repeats input',async t=>{
 const f=await fixture(t);f.server.host.persistentSession=true;const tab=await f.tabs.open({});
 f.manager.write(tab.id,'one-time');await until(()=>f.server.received.length);f.tabs.setAutoReconnect(tab.id,true);f.server.drop();
 await until(()=>f.reads()===2&&f.tabs.get(tab.id).status==='connected');
 assert.equal(f.tabs.get(tab.id).sessionRef,tab.sessionRef);assert.equal(f.server.state.persistent.size,1);assert.equal(f.server.received.join(''),'one-time');
});
test('termination is serialized, and cancellation while ending cannot leave a pending tab',async t=>{
 const f=await fixture(t);f.server.host.persistentSession=true;const tab=await f.tabs.open({});
 let finish;f.manager.terminatePersistent=()=>new Promise(resolve=>{finish=resolve});
 const end=f.tabs.terminate(tab.id);await assert.rejects(f.tabs.terminate(tab.id),/Connect to/);
 f.tabs.cancel(tab.id);finish();await end;
 assert.equal(f.tabs.get(tab.id).pending,false);assert.equal(f.tabs.get(tab.id).status,'closed');
});
