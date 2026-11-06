'use strict';
// Explicit opt-in integration check; never connects to a user's SSH host.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {ConnectionManager} = require('../electron/connections.cjs');
const {TerminalSessions} = require('../electron/terminal-sessions.cjs');

const docker = (...args) => execFileSync('docker', args, {encoding:'utf8', timeout:30000, stdio:['ignore','pipe','pipe']}).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* Container/PTY may still be starting. */ }
    await pause(100);
  }
  throw new Error('Timed out waiting for the real tmux fixture');
}
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-tmux-'));
  let container, manager;
  try {
    execFileSync('ssh-keygen', ['-q','-t','ed25519','-N','','-f',path.join(dir,'key')]);
    await new Promise((resolve, reject) => {
      const build = spawn('docker', ['build','-t','harbor-tmux-test:local',path.resolve(__dirname,'../tests/fixtures/tmux')], {stdio:'inherit'});
      build.on('error', reject);
      build.on('exit', code => code === 0 ? resolve() : reject(new Error(`Docker build failed (${code})`)));
    });
    container = docker('run','--detach','--rm','--publish','127.0.0.1::22','--mount',`type=bind,src=${path.join(dir,'key.pub')},dst=/test-key.pub,readonly`,'harbor-tmux-test:local');
    const port = Number(docker('port',container,'22/tcp').split(':').pop());
    const remote = (...args) => docker('exec','--user','harbor',container,...args);
    await until(() => docker('exec',container,'test','-f','/etc/ssh/ssh_host_ed25519_key.pub') === '');
    const publicKeys = docker('exec',container,'sh','-c','cat /etc/ssh/ssh_host_*_key.pub');
    const fingerprints = new Set(publicKeys.split('\n').map(line => 'SHA256:' + createHash('sha256').update(Buffer.from(line.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'')));
    let verifications = 0, rejectHost = false;
    manager = new ConnectionManager({verifyHost:async ({fingerprint}) => {verifications++; return !rejectHost && fingerprints.has(fingerprint);}});
    const host = {id:'fixture',label:'Disposable tmux fixture',hostname:'127.0.0.1',port,username:'harbor',persistentSession:true};
    const credential = {privateKey:await fs.readFile(path.join(dir,'key'),'utf8')};
    const sessions = new TerminalSessions(manager,async () => ({host,credential}));
    const first = await sessions.open({hostId:host.id});
    const second = await sessions.open({hostId:host.id});
    assert.notEqual(first.sessionRef,second.sessionRef);
    const names = () => remote('tmux','list-sessions','-F','#{session_name}').split('\n').sort();
    await until(() => names().length === 2);
    const expected = [first.sessionRef,second.sessionRef].sort();
    assert.deepEqual(names(),expected);
    manager.write(first.id,"printf '%s\\n' \"$$\" > ~/shell-pid; printf 'once\\n' >> ~/marker; sleep 600 & printf '%s\\n' \"$!\" > ~/job-pid\r");
    await until(() => remote('cat','/home/harbor/marker') === 'once' && /^\d+$/.test(remote('cat','/home/harbor/job-pid')));
    const shellPid = remote('cat','/home/harbor/shell-pid');
    const jobPid = remote('cat','/home/harbor/job-pid');
    const panePid = ref => remote('tmux','list-panes','-t',`=${ref}`,'-F','#{pane_pid}');
    assert.equal(panePid(first.sessionRef),shellPid);
    const stillRunning = () => {
      assert.deepEqual(names(),expected);
      assert.equal(panePid(first.sessionRef),shellPid);
      remote('kill','-0',jobPid);
      assert.equal(remote('cat','/home/harbor/marker'),'once');
    };
    sessions.cancel(first.id);
    stillRunning();
    await sessions.reconnect(first.id);
    assert.equal(sessions.get(first.id).status,'connected');
    stillRunning();
    manager.closeAll({preservePersistent:true,vaultId:'fixture-vault'});
    stillRunning();
    const checksBeforeUnlock = verifications;
    const restored = sessions.restoreSuspended([host],'fixture-vault');
    assert.equal(restored.length,2);
    assert(restored.every(tab => tab.status === 'closed' && !tab.autoReconnect));
    assert.equal(manager.sessions.size,0);
    assert.equal(verifications,checksBeforeUnlock);
    await sessions.reconnect(first.id);
    assert(verifications > checksBeforeUnlock);
    stillRunning();
    // Reopening the persisted workspace reference in a fresh tab uses the same shell.
    manager.closeAll();
    const reopened = await sessions.open({hostId:host.id,sessionRef:first.sessionRef});
    stillRunning();
    rejectHost = true;
    await assert.rejects(sessions.open({hostId:host.id}),/verification|host key/i);
    rejectHost = false;
    stillRunning();
    await sessions.terminate(reopened.id);
    await until(() => names().length === 1);
    assert.deepEqual(names(),[second.sessionRef]);
    assert.equal(sessions.get(reopened.id).event.reason,'ended');
    docker('exec',container,'mv','/usr/bin/tmux','/usr/bin/tmux-disabled');
    await assert.rejects(sessions.open({hostId:host.id}),/tmux is unavailable/);
    console.log('PASS: real OpenSSH/tmux — distinct panes, process survival, reconnect, lock/unlock, saved reference, fresh host verification, targeted termination and missing tmux.');
    console.log('Fixture:',docker('exec',container,'/usr/bin/tmux-disabled','-V'));
  } finally {
    manager?.closeAll();
    if (container) docker('rm','--force',container);
    await fs.rm(dir,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
