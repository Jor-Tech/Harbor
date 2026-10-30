const {generateKeyPair}=require('../electron/keys.cjs');
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Server,utils,AgentProtocol}=require('ssh2');
const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {ConnectionManager}=require('../electron/connections.cjs');
const {AuthPrompts}=require('../electron/auth-prompts.cjs');
const {keyInfo,agentSocket}=require('../electron/ssh-agent.cjs');
const hostKey=require('node:crypto').generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const encrypted=generateKeyPair('ed25519',{passphrase:'key-test-passphrase',cipher:'aes256-cbc',rounds:4});
const plain=utils.parseKey(encrypted.private,'key-test-passphrase');
async function mfaServer(t,{allowedKey=plain,multiRound=false,requirePassword=false}={}){
 const clients=new Set(),attempts=[];
 const server=new Server({hostKeys:[hostKey]},client=>{
  clients.add(client);let keyAccepted=false,passwordAccepted=false;client.on('error',()=>{});client.on('close',()=>clients.delete(client));
  client.on('authentication',ctx=>{
   attempts.push(ctx.method);
   if(ctx.method==='publickey'&&!keyAccepted&&ctx.key.data.equals(allowedKey.getPublicSSH())){
    if(!ctx.signature){ctx.accept();return;}
    if(allowedKey.verify(ctx.blob,ctx.signature,ctx.hashAlgo)!==true){ctx.reject();return;}
    keyAccepted=true;ctx.reject(requirePassword?['password']:['keyboard-interactive'],true);return;
   }
   if(ctx.method==='password'&&keyAccepted&&requirePassword){
    if(ctx.password==='server-test-password'){passwordAccepted=true;ctx.reject(['keyboard-interactive'],true)}else ctx.reject(['password']);return;
   }
   if(ctx.method==='keyboard-interactive'&&keyAccepted&&(!requirePassword||passwordAccepted)){
    const finish=()=>ctx.prompt([{prompt:'Verification code',echo:false}],'Two-factor authentication','Enter the current code.',answers=>{
     if(answers instanceof Error)return;
     if(answers[0]==='123456')ctx.accept();else ctx.reject(['keyboard-interactive']);
    });
    if(multiRound)ctx.prompt([{prompt:'Account confirmation',echo:true},{prompt:'Recovery phrase',echo:false}],'Additional verification','Two responses required',answers=>{if(answers instanceof Error)return;if(answers[0]==='test'&&answers[1]==='test-recovery')finish();else ctx.reject()});
    else finish();return;
   }
   ctx.reject(keyAccepted?(requirePassword&&!passwordAccepted?['password']:['keyboard-interactive']):['publickey']);
  });
  client.on('ready',()=>{
   client.on('session',accept=>{const session=accept();session.on('pty',accept=>accept());session.on('shell',accept=>{const stream=accept();stream.on('error',()=>{});stream.write('MFA success\r\n');stream.on('data',d=>stream.write(d))})});
   client.on('tcpip',accept=>{const stream=accept();stream.on('error',()=>{});stream.on('data',d=>stream.write(d))});
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const c of clients)c.end();await new Promise(r=>server.close(r))});
 return {host:{address:'127.0.0.1',port:server.address().port,username:'test',label:'MFA fixture'},attempts};
}
async function fakeAgent(t,keys=[plain],{deny=false}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-agent-')),socketPath=process.platform==='win32'?'\\\\.\\pipe\\harbor-test-'+require('node:crypto').randomUUID():path.join(dir,'agent.sock'),sockets=new Set(),signed=[];
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  const protocol=new AgentProtocol(false);protocol.on('error',()=>socket.destroy());socket.pipe(protocol).pipe(socket);
  protocol.on('identities',request=>protocol.getIdentitiesReply(request,keys));
  protocol.on('sign',(request,pubKey,data,options)=>{
   if(deny){protocol.failureReply(request);return;}
   const key=keys.find(k=>k.getPublicSSH().equals(pubKey.getPublicSSH()));
   if(!key){protocol.failureReply(request);return;}
   signed.push(keyInfo(key).fingerprint);protocol.signReply(request,key.sign(data,options.hash));
  });
 });
 await new Promise(resolve=>server.listen(socketPath,resolve));
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})});
 return {socketPath,signed};
}
test('encrypted private key prompts for passphrase then completes publickey plus 2FA',async t=>{
 const f=await mfaServer(t),prompts=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async p=>{prompts.push(p);return[p.kind==='key-passphrase'?'key-test-passphrase':'123456']}});t.after(()=>manager.closeAll());
 const session=await manager.connect(f.host,{privateKey:encrypted.private});assert(session.id);
 assert.deepEqual(prompts.map(p=>p.kind),['key-passphrase','keyboard-interactive']);assert.equal(prompts[1].prompts[0].echo,false);
 assert(f.attempts.indexOf('publickey')<f.attempts.indexOf('keyboard-interactive'));
});
test('RSA key and agent signatures also continue to 2FA after partial authentication',async t=>{
 const pair=generateKeyPair('rsa',{bits:2048,passphrase:'rsa-passphrase',cipher:'aes256-cbc',rounds:4});
 const rsa=utils.parseKey(pair.private,'rsa-passphrase'),f=await mfaServer(t,{allowedKey:rsa}),a=await fakeAgent(t,[rsa]);
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async()=>['123456']});t.after(()=>manager.closeAll());
 await manager.connect(f.host,{privateKey:pair.private,passphrase:'rsa-passphrase'});
 await manager.connect(f.host,{useAgent:true,agentProvider:'custom',agentSocket:a.socketPath});
 assert.equal(a.signed.length,1);
});
test('saved key passphrase supports repeated rounds and multiple server prompts',async t=>{
 const f=await mfaServer(t,{multiRound:true}),prompts=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async p=>{prompts.push(p);return p.prompts.length===2?['test','test-recovery']:['123456']}});t.after(()=>manager.closeAll());
 await manager.connect(f.host,{privateKey:encrypted.private,passphrase:'key-test-passphrase'});
 assert.equal(prompts.length,2);assert.deepEqual(prompts[0].prompts.map(p=>p.echo),[true,false]);
});
test('wrong key passphrase can be corrected without persisting the response',async t=>{
 const f=await mfaServer(t);let attempts=0;
 const credential={privateKey:encrypted.private};
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async p=>[p.kind==='key-passphrase'?(++attempts===1?'wrong':'key-test-passphrase'):'123456']});t.after(()=>manager.closeAll());
 await manager.connect(f.host,credential);assert.equal(attempts,2);assert.equal(credential.passphrase,undefined);
});
test('invalid OTP rejects the connection',async t=>{
 const f=await mfaServer(t);const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async()=>['000000']});t.after(()=>manager.closeAll());
 await assert.rejects(manager.connect(f.host,{privateKey:encrypted.private,passphrase:'key-test-passphrase'}),/authentication failed/i);assert.equal(manager.sessions.size,0);
});
test('vault lock/close cancels a pending interactive prompt and rejects stale answers',async t=>{
 const f=await mfaServer(t);let shown;const ready=new Promise(r=>shown=r);const broker=new AuthPrompts((event,p)=>{if(event==='auth:prompt')shown(p)});
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:(p,o)=>broker.request(p,o)});t.after(()=>manager.closeAll());
 const connecting=manager.connect(f.host,{privateKey:encrypted.private,passphrase:'key-test-passphrase'});const rejected=assert.rejects(connecting,/cancelled|closed/i);const prompt=await ready;manager.closeAll();await rejected;
 assert.equal(broker.pending.size,0);assert.throws(()=>broker.answer(prompt.id,['123456']),/expired/);
});
test('agent signs with a selected identity and then completes server 2FA',async t=>{
 const other=utils.parseKey(generateKeyPair('ed25519').private);
 const a=await fakeAgent(t,[other,plain]),f=await mfaServer(t),prompts=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async p=>{prompts.push(p);return[p.kind==='agent-key'?keyInfo(plain).fingerprint:'123456']}});t.after(()=>manager.closeAll());
 await manager.connect(f.host,{useAgent:true,agentProvider:'custom',agentSocket:a.socketPath});
 assert.deepEqual(prompts.map(p=>p.kind),['agent-key','keyboard-interactive']);assert.deepEqual(a.signed,[keyInfo(plain).fingerprint]);
});
test('agent selection and key passphrase MFA work behind a separately authenticated bastion',async t=>{
 const {createRoutingServer}=require('./helpers/routing-server.cjs');
 const jump=await createRoutingServer({username:'bastion',password:'jump-password',otp:'777777'});t.after(()=>jump.close());
 const other=utils.parseKey(generateKeyPair('ed25519').private),agent=await fakeAgent(t,[other,plain]),target=await mfaServer(t),prompts=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async p=>{prompts.push(p);return [p.username==='bastion'?'777777':p.kind==='agent-key'?keyInfo(plain).fingerprint:p.kind==='key-passphrase'?'key-test-passphrase':'123456'];}});t.after(()=>manager.closeAll());
 const route=[{host:jump.host,credential:jump.credential}];
 await manager.connect(target.host,{useAgent:true,agentProvider:'custom',agentSocket:agent.socketPath},route);
 assert.deepEqual(prompts.map(p=>[p.username,p.kind]),[['bastion','keyboard-interactive'],['test','agent-key'],['test','keyboard-interactive']]);
 assert.equal(agent.signed.length,1);prompts.length=0;
 await manager.connect(target.host,{privateKey:encrypted.private},route);
 assert.deepEqual(prompts.map(p=>[p.username,p.kind]),[['bastion','keyboard-interactive'],['test','key-passphrase'],['test','keyboard-interactive']]);
});
test('pinned agent identity skips key selection and supports MFA for forwarding',async t=>{
 const a=await fakeAgent(t),f=await mfaServer(t),prompts=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async p=>{prompts.push(p);return['123456']}});t.after(()=>manager.closeAll());
 const tunnel=await manager.startForward(f.host,{useAgent:true,agentProvider:'custom',agentSocket:a.socketPath,agentFingerprint:keyInfo(plain).fingerprint},{localPort:0,remoteHost:'127.0.0.1',remotePort:8080});
 assert(tunnel.port>0);assert.deepEqual(prompts.map(p=>p.kind),['keyboard-interactive']);
});
test('agent denial and unavailable pinned key fail without importing private keys',async t=>{
 const a=await fakeAgent(t,[plain],{deny:true}),f=await mfaServer(t);
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async()=>['123456']});t.after(()=>manager.closeAll());
 await assert.rejects(manager.connect(f.host,{useAgent:true,agentProvider:'custom',agentSocket:a.socketPath}),/agent|authentication/i);
 await assert.rejects(manager.connect(f.host,{useAgent:true,agentProvider:'custom',agentSocket:a.socketPath,agentFingerprint:'SHA256:missing'}),/not available/);assert.deepEqual(a.signed,[]);
});
test('1Password selection uses its socket regardless of the inherited system-agent socket',()=>{
 assert.equal(agentSocket({agentProvider:'1password'},'linux','/home/test',{}),'/home/test/.1password/agent.sock');
 assert.equal(agentSocket({agentProvider:'custom',agentSocket:'~/custom-agent.sock'},'linux','/home/test',{}),'/home/test/custom-agent.sock');
 assert.throws(()=>agentSocket({agentProvider:'custom',agentSocket:'relative.sock'}),/absolute/);
});
test('prompt broker validates answer counts, handles cancellation, and expires requests',async()=>{
 const events=[];const broker=new AuthPrompts((event,p)=>events.push({event,...p}),20);
 const p=broker.request({prompts:[{prompt:'OTP',echo:false}]});const rejected=assert.rejects(p,/timed out/);const id=events[0].id;
 assert.throws(()=>broker.answer(id,[]),/Invalid/);await rejected;assert.equal(broker.pending.size,0);
 const p2=broker.request({prompts:[{prompt:'OTP',echo:false}]});const cancel=assert.rejects(p2,/cancelled/);broker.cancelAll();await cancel;
 assert(!JSON.stringify(events).includes('123456'));
});

test('agent key followed by unsaved server password and then OTP prompts for both factors',async t=>{
 const a=await fakeAgent(t),f=await mfaServer(t,{requirePassword:true}),prompts=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,requestAuth:async p=>{prompts.push(p.kind);return[p.kind==='server-password'?'server-test-password':'123456']}});t.after(()=>manager.closeAll());
 const credential={useAgent:true,agentProvider:'custom',agentSocket:a.socketPath};
 await manager.connect(f.host,credential);
 assert.deepEqual(prompts,['server-password','keyboard-interactive']);assert.equal(credential.password,undefined);
});
test('rejected agent identity reports that signing never started, without secrets',async t=>{
 const other=utils.parseKey(generateKeyPair('ed25519').private);
 const a=await fakeAgent(t,[other]),f=await mfaServer(t),events=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,emit:(event,data)=>events.push({event,data}),requestAuth:async()=>{throw new Error('No password or OTP should be requested')}});t.after(()=>manager.closeAll());
 await assert.rejects(manager.connect(f.host,{useAgent:true,agentProvider:'custom',agentSocket:a.socketPath}),/did not request a signature/);
 const detail=events.find(e=>e.event==='auth:failure').data;
 assert.equal(detail.signingRequested,false);assert.equal(detail.signatureReturned,false);assert.equal(detail.fingerprint,keyInfo(other).fingerprint);
 assert.deepEqual(detail.remainingMethods,['publickey']);assert.deepEqual(detail.acceptedFactors,[]);assert.equal(a.signed.length,0);
 assert(!JSON.stringify(events).includes('PRIVATE KEY'));assert(!JSON.stringify(events).includes('123456'));
});
test('agent signing denial and failed second factor have distinct diagnostics',async t=>{
 const f=await mfaServer(t),denied=await fakeAgent(t,[plain],{deny:true}),allowed=await fakeAgent(t),events=[];
 const manager=new ConnectionManager({verifyHost:async()=>true,emit:(event,data)=>{if(event==='auth:failure')events.push(data)},requestAuth:async()=>['000000']});t.after(()=>manager.closeAll());
 await assert.rejects(manager.connect(f.host,{useAgent:true,agentProvider:'custom',agentSocket:denied.socketPath}),/could not sign/);
 assert.equal(events[0].signingRequested,true);assert.equal(events[0].signatureReturned,false);
 await assert.rejects(manager.connect(f.host,{useAgent:true,agentProvider:'custom',agentSocket:allowed.socketPath}),/accepted the SSH key/);
 assert.equal(events[1].signatureReturned,true);assert.deepEqual(events[1].acceptedFactors,['agent']);assert.equal(events[1].verificationPrompted,true);
});
