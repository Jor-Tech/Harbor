'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {rules,savedApprovals}=require('../electron/mcp/rules.cjs'),{McpSsh}=require('../electron/mcp/ssh.cjs');
test('GUI rules are exact by default, validate explicit broad scope, and cannot widen headless rules',()=>{
 const c={hostIds:['one'],rights:['connect','exec','files:read','files:write']};
 assert.deepEqual(rules(c,[{tool:'harbor_exec',hostId:'one',command:'uptime'}]),[{tool:'harbor_exec',hostId:'one',command:'uptime'}]);
 assert.throws(()=>rules(c,[{tool:'harbor_exec',hostId:'one',scope:'all-commands'}]));
 assert.deepEqual(rules(c,[{tool:'harbor_exec',hostId:'one',scope:'all-commands'}],{allowAllCommands:true})[0].scope,'all-commands');
 for(const bad of [{tool:'harbor_exec',hostId:'one',scope:'all-commands',command:'uptime'},{tool:'harbor_read_file',hostId:'one',scope:'all-commands',path:'/x'},{tool:'harbor_read_file',hostId:'one',path:'/a/../x'},{tool:'harbor_write_file',hostId:'one',path:'/x'},{tool:'harbor_connect',hostId:'other'}])assert.throws(()=>rules(c,[bad],{allowAllCommands:true}));
 const entry={id:randomUUID(),rule:{tool:'harbor_connect',hostId:'one'},binding:'a'.repeat(64),destination:'test@host:22'};
 assert.equal(savedApprovals(c,[entry]).length,1);assert.throws(()=>savedApprovals(c,[{...entry,binding:''}]));assert.throws(()=>savedApprovals(c,[entry,entry]));assert.throws(()=>savedApprovals(c,[{...entry,token:'secret'}]));
});
test('standing approval identity binds server, account and jump route without hashing credentials',async()=>{
 const resolved={host:{id:'one',label:'Test',address:'host.invalid',port:22,username:'test'},credential:{username:'test',password:'secret'},route:[{host:{address:'jump.invalid',port:2222,username:'jump'},credential:{username:'jump',password:'another secret'}}]};
 const ssh=new McpSsh({resolve:async()=>resolved}),original=await ssh.describe('one');
 resolved.credential.password='rotated';resolved.route[0].credential.password='also rotated';resolved.host.label='Renamed';
 const rotated=await ssh.describe('one');assert.equal(rotated.approvalDigest,original.approvalDigest);assert.notEqual(rotated.digest,original.digest);
 for(const [object,key,value] of [[resolved.host,'address','new.invalid'],[resolved.credential,'username','root'],[resolved.host,'port',2222],[resolved.route[0].host,'address','other-jump.invalid'],[resolved.route[0].credential,'username','root']]){
  const old=object[key];object[key]=value;assert.notEqual((await ssh.describe('one')).approvalDigest,original.approvalDigest);object[key]=old;
 }
 resolved.credential.username='';resolved.host.username='';resolved.host.hostname='effective.invalid';
 const defaults=await ssh.describe('one');assert.equal(defaults.target.username,require('node:os').userInfo().username);assert.equal(defaults.target.address,'effective.invalid');
});

test('explicit GUI write grants validate scope, paths and ordinary rights while implicit write grants stay disabled',()=>{
 const {matchesRule}=require('../electron/mcp/rules.cjs'),c={hostIds:['one'],rights:['files:write','files:read']};
 for(const fields of [{path:'/work/file'},{scope:'directory',path:'/work'},{scope:'all-paths'}]){
  const rule={tool:'harbor_write_file',hostId:'one',...fields};
  assert.throws(()=>rules(c,[rule]));assert.throws(()=>rules(c,[rule],{allowAllCommands:true}));
  assert.deepEqual(rules(c,[rule],{allowFileWrites:true})[0],rule);
  assert.equal(savedApprovals(c,[{id:randomUUID(),rule,binding:'a'.repeat(64),destination:'test@host:22'}]).length,1);
  assert(matchesRule(rule,'harbor_write_file','one',{path:'/work/file',content:'any content'}));
  assert(!matchesRule(rule,'harbor_write_file','other',{path:'/work/file'}));
  assert(!matchesRule(rule,'harbor_read_file','one',{path:'/work/file'}));
  assert(!matchesRule(rule,'harbor_write_file','one',{path:'/work/../outside'}));
  if(fields.scope!=='all-paths')assert(!matchesRule(rule,'harbor_write_file','one',{path:'/worker/file'}));
  assert.throws(()=>rules({...c,rights:['files:read']},[rule],{allowFileWrites:true}));
 }
 for(const fields of [{path:'relative'},{path:'/work/../file'},{scope:'all-paths',path:'/work'},{scope:'directory',path:'/work/'},{path:'/work/file',content:'secret'},{scope:'all-commands'}])assert.throws(()=>rules(c,[{tool:'harbor_write_file',hostId:'one',...fields}],{allowFileWrites:true}));
 assert.throws(()=>rules(c,[{tool:'harbor_read_file',hostId:'one',scope:'all-paths'}],{allowFileWrites:true}));
});

test('GUI read/list scopes require explicit configuration and match complete path components',()=>{
 const {matchesRule}=require('../electron/mcp/rules.cjs');
 const c={hostIds:['one'],rights:['files:read','files:list','files:write']};
 for(const tool of ['harbor_read_file','harbor_list_files']){
  for(const fields of [{scope:'directory',path:'/work'},{scope:'directory',path:'/'},{scope:'all-paths'}]){
   const rule={tool,hostId:'one',...fields};
   assert.throws(()=>rules(c,[rule])); // Request remembering remains exact-only.
   assert.deepEqual(rules(c,[rule],{allowFileScopes:true})[0],rule);
   assert.equal(savedApprovals(c,[{id:randomUUID(),rule,binding:'a'.repeat(64),destination:'test@host:22'}]).length,1);
   for(const path of ['/work','/work/sub','/work/sub/file.txt'])assert(matchesRule(rule,tool,'one',{path}));
   if(fields.path==='/work')for(const path of ['/worker','/work-other/file','/outside'])assert(!matchesRule(rule,tool,'one',{path}));
   for(const path of ['relative','/work/../outside','/work//sub','/work/./file'])assert(!matchesRule(rule,tool,'one',{path}));
   assert(!matchesRule(rule,tool,'other',{path:'/work/file'}));
   assert(!matchesRule(rule,'harbor_write_file','one',{path:'/work/file'}));
   assert.throws(()=>rules({...c,hostRights:{one:[]}},[rule],{allowFileScopes:true}));
  }
  assert(!matchesRule({tool,hostId:'one',path:'/work'},tool,'one',{path:'/work/file'}));
  for(const fields of [{scope:'directory',path:'/work/'},{scope:'directory',path:'/work/../else'},{scope:'all-paths',path:'/'},{scope:'all-commands'}])assert.throws(()=>rules(c,[{tool,hostId:'one',...fields}],{allowFileScopes:true}));
 }
 assert.throws(()=>rules(c,[{tool:'harbor_write_file',hostId:'one',scope:'all-paths'}],{allowFileScopes:true}));
});
