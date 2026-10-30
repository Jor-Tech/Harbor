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
