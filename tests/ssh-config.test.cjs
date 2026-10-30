'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {parseConfig,previewConfig,applyImport}=require('../electron/ssh-config.cjs');
const {initialData}=require('../electron/vault.cjs');
test('SSH config imports literal aliases with case-insensitive directives and first obtained values',()=>{
 const p=parseConfig('Host prod alias\n HostName = "prod.example.test" # comment\n User deploy\n Port 2222\nHost * !excluded\n User fallback\n Port 22\nHost excluded\n HostName excluded.test\n');
 assert.deepEqual(p.entries.map(e=>[e.alias,e.host.username,e.host.port]),[['prod','deploy',2222],['alias','deploy',2222],['excluded','',22]]);assert.equal(p.entries[0].host.address,'prod.example.test');
 const first=parseConfig('User global\nHost server\n User specific\nHost server\n Port 2200');assert.equal(first.entries.length,1);assert.equal(first.entries[0].host.username,'global');assert.equal(first.entries[0].host.port,2200);
});
test('wildcard defaults do not create hosts and quoted comments remain literal',()=>{
 const p=parseConfig('Host *.test\n User wildcard\nHost api.test other\n IdentityFile "~/.ssh/key # one"\n HostName %h\n');assert.equal(p.entries.length,2);assert.equal(p.entries[0].host.username,'wildcard');assert.equal(p.entries[1].host.username,'');assert.equal(p.entries[0].host.address,'api.test');assert.equal(p.entries[0].warnings[0].directive,'identityfile');
 assert.equal(parseConfig('Host *\n User default').entries.length,0);assert.throws(()=>parseConfig('Host "broken'),/Unclosed/);
});
test('Match and Include are reported without executing or reading referenced commands/files',()=>{
 const p=parseConfig('Include /does/not/exist\nHost safe\n User normal\nMatch exec "touch /tmp/should-not-exist"\n User dangerous\nHost next\n User nextuser\n');
 assert.equal(p.entries[0].host.username,'normal');assert.equal(p.entries[1].host.username,'nextuser');assert(p.diagnostics.some(w=>w.directive==='Match'));assert(p.entries.every(e=>e.warnings.some(w=>w.directive==='include')));assert(!JSON.stringify(p).includes('touch'));
});
test('unsafe-to-approximate routes and invalid hosts are blocked',()=>{
 for(const option of ['ProxyCommand nc %h %p','ProxyJump a,b','ProxyJump user@jump:2222','CanonicalizeHostname yes','Port -1','HostName %unsupported'])assert(parseConfig('Host target\n '+option).entries[0].blocked.length,option);
 assert.throws(()=>parseConfig('Host x\n User'),/needs a value/);assert.throws(()=>parseConfig('x'.repeat(1024*1024+1)),/1 MiB/);
});
test('agent socket paths are expanded statically and environment variables are not read',()=>{
 const home=process.platform==='win32'?String.raw`C:\Users\test`:'/home/test';
 const p=parseConfig('Host custom\n IdentityAgent "~/.ssh/agent.sock"\nHost system\n IdentityAgent SSH_AUTH_SOCK\nHost env\n IdentityAgent ${SECRET}/agent.sock',{home});
 assert.equal(p.entries[0].host.agentSocket,path.join(home,'.ssh','agent.sock'));assert.equal(p.entries[1].host.agentProvider,'system');assert.equal(p.entries[2].host.agentProvider,'none');assert.equal(p.entries[2].warnings.length,1);
});
test('selection applies atomically with jump dependencies, existing keys, and no host replacement',()=>{
 const d=initialData();d.keys.push({id:'key',label:'Existing key',privateKey:'test'});const p=previewConfig('Host jump\n HostName jump.test\nHost target\n HostName target.internal\n ProxyJump jump',d);
 const selections=p.entries.map(e=>({id:e.id,auth:e.alias==='jump'?'1password':'key:key'})),result=applyImport(p,d,selections);
 assert.equal(d.hosts.length,0);assert.equal(result.hosts[1].jumpHostId,result.hosts[0].id);assert.equal(result.hosts[0].agentProvider,'1password');assert.equal(result.hosts[1].keyId,'key');
 assert.throws(()=>applyImport(p,d,[selections[1]]),/Also select/);assert.throws(()=>applyImport(p,d,[selections[0],selections[0]]),/Invalid/);
 const cycles=previewConfig('Host a\n ProxyJump b\nHost b\n ProxyJump a',d);assert.throws(()=>applyImport(cycles,d,cycles.entries.map(e=>({id:e.id}))),/cycle/);
});
test('duplicate hosts and unsupported options require explicit acknowledgement at apply time',()=>{
 const d=initialData();d.hosts.push({id:'existing',label:'Already here',address:'example.test',port:22,username:'u'});
 const p=previewConfig('Host new\n HostName example.test\n User u\n ForwardAgent yes',d);assert.equal(p.entries[0].duplicates.length,1);
 const choices=[{id:p.entries[0].id}];assert.throws(()=>applyImport(p,d,choices),/acknowledge/);assert.throws(()=>applyImport(p,d,choices,{acknowledgeWarnings:true}),/Duplicates/);
 const result=applyImport(p,d,choices,{acknowledgeWarnings:true,allowDuplicates:true});assert.equal(result.hosts.length,2);assert.deepEqual(result.hosts[0],d.hosts[0]);
 const clean=previewConfig('Host later\n HostName later.test',d);d.hosts.push({id:'late',label:'later',address:'elsewhere.test'});assert.throws(()=>applyImport(clean,d,[{id:clean.entries[0].id}]),/Duplicates/);
});
