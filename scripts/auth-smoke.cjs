const {generateKeyPair}=require('../electron/keys.cjs');
const {_electron:electron}=require('playwright');
const {Server,utils}=require('ssh2');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-auth-ui-'));
 const pair=generateKeyPair('ed25519',{passphrase:'test-key-passphrase',cipher:'aes256-cbc',rounds:4});
 const key=utils.parseKey(pair.private,'test-key-passphrase');
 const clients=new Set();let app;
 const server=new Server({hostKeys:[require('node:crypto').generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'})]},client=>{
  clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));let firstFactor=false,passwordAccepted=false;
  client.on('authentication',ctx=>{
   if(ctx.username!=='test'){ctx.reject(['publickey']);return;}
   if(ctx.method==='publickey'&&ctx.key.data.equals(key.getPublicSSH())){
    if(!ctx.signature){ctx.accept();return}
    if(key.verify(ctx.blob,ctx.signature,ctx.hashAlgo)!==true){ctx.reject();return}
    firstFactor=true;ctx.reject(['password'],true);return;
   }
   if(ctx.method==='password'&&firstFactor){if(ctx.password==='test-server-password'){passwordAccepted=true;ctx.reject(['keyboard-interactive'],true)}else ctx.reject(['password']);return;}
   if(ctx.method==='keyboard-interactive'&&firstFactor&&passwordAccepted){ctx.prompt([{prompt:'Verification code',echo:false}],'Two-factor authentication','Enter the current code from your authenticator.',answers=>{if(answers instanceof Error)return;if(answers[0]==='654321')ctx.accept();else ctx.reject()});return;}
   ctx.reject(firstFactor?['password']:['publickey']);
  });
  client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',a=>a());session.on('shell',a=>{const stream=a();stream.on('error',()=>{});stream.write('MFA_UI_SUCCESS\r\n')})}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-auth-test-password');await page.getByLabel('Confirm password',{exact:true}).fill('Harbor-auth-test-password');await page.getByRole('button',{name:'Create vault',exact:true}).click();
  await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})});
  await page.evaluate(async({privateKey,port})=>{
   const d=await window.harbor.invoke('entity:save',{collection:'keys',item:{label:'Protected key',privateKey,passphrase:''}});
   await window.harbor.invoke('entity:save',{collection:'hosts',item:{label:'MFA test server',address:'127.0.0.1',port,username:'outdated-username',keyId:d.keys[0].id}});
  },{privateKey:pair.private,port:server.address().port});
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-auth-test-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await page.evaluate(()=>{window.authTerminalOutput='';window.harbor.on('terminal:data',e=>window.authTerminalOutput+=e.data)});
  // The editor must persist the shown settings before connecting by host ID.
  await page.locator('.host-card .host-body').click();
  await page.getByLabel('Username',{exact:true}).fill('test');
  await page.getByRole('button',{name:'Save & connect',exact:true}).click();
  await page.getByRole('heading',{name:'Unlock SSH key',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Key passphrase',{exact:true}).getAttribute('type'),'password');
  await page.getByLabel('Key passphrase',{exact:true}).fill('test-key-passphrase');await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('heading',{name:'Server account password',exact:true}).waitFor();
  await page.locator('input[aria-label="Server account password"]').fill('test-server-password');await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('heading',{name:'SSH verification',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Verification code',{exact:true}).getAttribute('type'),'password');
  await page.screenshot({path:'research/harbor-2fa.png'});
  await page.getByLabel('Verification code',{exact:true}).fill('654321');await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.waitForFunction(()=>window.authTerminalOutput.includes('MFA_UI_SUCCESS'));
  await page.locator('.terminal-pane:visible .xterm').waitFor();
  const data=await page.evaluate(()=>window.harbor.invoke('vault:read'));
  assert.equal(data.hosts[0].username,'test');assert.equal(data.keys[0].passphrase,'');assert(!JSON.stringify(data).includes('test-key-passphrase'));assert(!JSON.stringify(data).includes('654321'));assert(!JSON.stringify(data).includes('test-server-password'));
  // A new connection's passphrase prompt can be cancelled without opening a session.
  await page.getByRole('button',{name:'Workspace',exact:true}).click();
  await page.locator('.host-card').getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByRole('heading',{name:'Unlock SSH key',exact:true}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('heading',{name:'Unlock SSH key',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.locator('.terminal-pane').count(),1);
  // Vault lock cancels the prompt and clears it from the renderer.
  await page.locator('.host-card').getByRole('button',{name:'Connect',exact:true}).click();await page.getByRole('heading',{name:'Unlock SSH key',exact:true}).waitFor();
  await page.evaluate(()=>window.harbor.invoke('vault:lock'));await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
  // Rejected identity yields persistent, readable diagnostics instead of a generic toast.
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-auth-test-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await page.evaluate(async privateKey=>{const d=await window.harbor.invoke('vault:read');await window.harbor.invoke('entity:save',{collection:'keys',item:{...d.keys[0],privateKey}})},generateKeyPair('ed25519').private);
  await page.locator('.host-card').getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByRole('heading',{name:'SSH authentication failed',exact:true}).waitFor();
  await page.getByText('None reported',{exact:true}).waitFor();
  await page.screenshot({path:'research/harbor-auth-failure.png'});
  await page.evaluate(()=>window.harbor.invoke('vault:lock'));await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: editor saves current connection settings; UI key passphrase → server password → SSH 2FA → terminal, failure details, transient responses, cancellation and lock cleanup.');
 }finally{await app?.close();for(const c of clients)c.end();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
