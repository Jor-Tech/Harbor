'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const {agentEndpoint, localShell, WINDOWS_AGENT} = require('../electron/platform.cjs');
const {absolute, remoteAbsolute, filename, transferPaths} = require('../electron/file-paths.cjs');
const {Files} = require('../electron/files.cjs');
const {Vault} = require('../electron/vault.cjs');

test('agent endpoints are platform-specific and explicit providers ignore SSH_AUTH_SOCK', () => {
  const env = {SSH_AUTH_SOCK:'/some/other/agent'};
  assert.equal(agentEndpoint({agentProvider:'1password'},'linux','/home/me',env),'/home/me/.1password/agent.sock');
  assert.equal(agentEndpoint({agentProvider:'1password'},'darwin','/Users/me',env),'/Users/me/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock');
  assert.equal(agentEndpoint({agentProvider:'1password'},'win32','C:\\Users\\me',env),WINDOWS_AGENT);
  assert.equal(agentEndpoint({},'win32','C:\\Users\\me',{}),WINDOWS_AGENT);
  const custom = '\\\\.\\pipe\\my-agent';
  assert.equal(agentEndpoint({agentProvider:'custom',agentSocket:custom},'win32'),custom);
  assert.equal(agentEndpoint({},'darwin','/Users/me',env),env.SSH_AUTH_SOCK);
  for (const value of ['relative','C:\\agent.sock','\\\\server\\pipe\\agent','\\\\.\\pipe\\']) {
    assert.throws(()=>agentEndpoint({agentProvider:'custom',agentSocket:value},'win32'),/named pipe/);
  }
});

test('Windows transfers keep remote paths POSIX and local paths native', () => {
  const up=transferPaths('upload',path.win32), down=transferPaths('download',path.win32);
  assert.equal(up.target.join('/srv/data','child','file.txt'),'/srv/data/child/file.txt');
  assert.equal(up.source.join('C:\\Users\\me','child'),'C:\\Users\\me\\child');
  assert.equal(down.source.dirname('/srv/file.txt'),'/srv');
  assert.equal(down.target.join('\\\\server\\share','file.txt'),'\\\\server\\share\\file.txt');
  assert.equal(remoteAbsolute('/srv/../file'),'/file');
  assert.throws(()=>remoteAbsolute('C:\\srv\\file'),/absolute/);
  assert.equal(absolute('C:\\folder\\..\\file',path.win32),'C:\\file');
  for(const value of ['NUL','com1.txt','file:stream','trailing.','trailing ','a?b']) assert.throws(()=>filename(value,'win32'),/Windows/);
  assert.equal(filename('normal.txt','win32'),'normal.txt');
});

test('local listings expose usable native entry and parent paths', async t => {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-paths-'));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  await fs.writeFile(path.join(folder,'file.txt'),'sample');
  const listing=await new Files({}).listLocal(folder);
  assert.equal(listing.parentPath,path.dirname(await fs.realpath(folder)));
  assert.equal(await fs.readFile(listing.entries[0].path,'utf8'),'sample');
  const root=path.parse(folder).root;
  assert.equal((await new Files({}).listLocal(root)).parentPath,root);
});

test('local shells select Windows command interpreter and macOS login shell', () => {
  assert.deepEqual(localShell('win32',{COMSPEC:'C:\\Windows\\System32\\cmd.exe'}),{file:'C:\\Windows\\System32\\cmd.exe',args:[]});
  assert.deepEqual(localShell('darwin',{}),{file:'/bin/zsh',args:['-l']});
  assert.deepEqual(localShell('linux',{SHELL:'/bin/fish'}),{file:'/bin/fish',args:[]});
});

test('remote rename follows POSIX rules even on a Windows client', async () => {
  let renamed;
  const sftp={lstat:(_path,callback)=>callback(Object.assign(new Error('missing'),{code:2})),rename:(source,target,callback)=>{renamed=[source,target];callback()}};
  const files=new Files({_sftp:async()=>sftp});
  await files.rename('session','/srv/file.txt','aux.txt');
  assert.deepEqual(renamed,['/srv/file.txt','/srv/aux.txt']);
});

test('every desktop reads the same encrypted vault fixture and can re-save it', async t => {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-portable-vault-'));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const vault=new Vault(path.join(folder,'vault.hbr'));
  const data=await vault.importFrom(path.join(__dirname,'fixtures','portable-vault.json'),'portable-fixture-password');
  assert.equal(data.hosts[0].address,'portable.example.test');
  data.hosts[0].label='Updated on '+process.platform;
  await vault.save(data);vault.lock();
  assert.equal((await vault.unlock('portable-fixture-password')).hosts[0].label,data.hosts[0].label);
  vault.lock();
});

// Exercise the serializer failure deterministically, not by hoping a random key fails.
test('generated SSH keys are parsed and matched before being returned',()=>{
  const {generateKeyPair}=require('../electron/keys.cjs');
  const {utils}=require('ssh2');
  const good=generateKeyPair();let calls=0;
  const recovered=generateKeyPair('ed25519',{},()=>++calls===1?{private:'invalid',public:'invalid'}:good);
  assert.equal(calls,2);assert.equal(recovered.private,good.private);
  const key=utils.parseKey(recovered.private);const data=Buffer.from('synthetic signing test');
  assert.equal(key.verify(data,key.sign(data)),true);
  calls=0;assert.throws(()=>generateKeyPair('ed25519',{},()=>{calls++;return {private:'invalid',public:'invalid'}}),/valid SSH key/);assert.equal(calls,4);
});
