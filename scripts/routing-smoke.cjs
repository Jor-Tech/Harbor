'use strict';
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {once}=require('node:events');
const {createRoutingServer}=require('../tests/helpers/routing-server.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-routing-ui-'));
 const jump=await createRoutingServer({username:'bastion',password:'jump-password',otp:'111111'});
 const target=await createRoutingServer({username:'target',password:'target-password',otp:'222222'});
 const sockets=new Set();
 const echo=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));s.pipe(s);});
 await new Promise(r=>echo.listen(0,'127.0.0.1',r));let app;
 try {
  await fs.writeFile(path.join(target.root,'private-note.txt'),'Through a bastion');
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-routing-password');await page.getByLabel('Confirm password',{exact:true}).fill('Harbor-routing-password');await page.getByRole('button',{name:'Create vault',exact:true}).click();
  await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})});
  await page.evaluate(async host=>window.harbor.invoke('entity:save',{collection:'hosts',item:{...host,label:'Office bastion',password:'jump-password'}}),jump.host);
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-routing-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await page.getByRole('button',{name:'New host',exact:true}).click();await page.getByLabel('Label',{exact:true}).fill('Private application');await page.getByLabel('Address',{exact:true}).fill('app.internal.test');await page.getByLabel('Port',{exact:true}).fill(String(target.host.port));await page.getByLabel('Username',{exact:true}).fill('target');await page.getByLabel('Account password',{exact:true}).fill('target-password');await page.getByLabel('Connect through',{exact:true}).selectOption({label:'Office bastion'});
  await page.screenshot({path:'research/harbor-jump-host.png'});
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('heading',{name:'New host',exact:true}).waitFor({state:'hidden'});
  await page.locator('.host-card').filter({hasText:'Private application'}).getByRole('button',{name:'Connect',exact:true}).click();
  const answerMfa=async()=>{for(const [label,code] of [['Office bastion','111111'],['Private application','222222']]){
   await page.locator('.auth-host strong').getByText(label,{exact:true}).waitFor();await page.getByLabel('Verification code',{exact:true}).fill(code);await page.getByRole('button',{name:'Continue',exact:true}).click();
  }};
  await answerMfa();await page.locator('.terminal-pane:visible .xterm').waitFor();
  await page.getByRole('button',{name:'SFTP',exact:true}).click();await page.getByRole('region',{name:'Remote files'}).getByRole('button',{name:'private-note.txt',exact:true}).waitFor();
  await page.getByRole('button',{name:'Port Forwarding',exact:true}).click();
  for(const type of ['local','remote','dynamic']){
   await page.getByRole('button',{name:'New rule',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill(type+' test');await page.getByLabel('Forwarding type',{exact:true}).selectOption(type);await page.getByLabel('SSH host',{exact:true}).selectOption({label:'Private application'});
   await page.getByLabel(type==='remote'?'Listen port on SSH server':'Listen port on this device',{exact:true}).fill('0');
   if(type!=='dynamic'){await page.getByLabel('Destination hostname',{exact:true}).fill('127.0.0.1');await page.getByLabel('Destination port',{exact:true}).fill(String(echo.address().port));}
   await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('heading',{name:'Port forwarding',exact:true}).waitFor({state:'hidden'});
   const card=page.locator('.forward-card').filter({hasText:type+' test'});
   await card.getByRole('button',{name:'Start',exact:true}).click();await answerMfa();await card.getByRole('button',{name:'Stop',exact:true}).waitFor();
   const port=Number((await card.locator('p').first().innerText()).match(/127\.0\.0\.1:(\d+)/)[1]);assert(port>0);
   const s=net.connect(port,'127.0.0.1');sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));await once(s,'connect');
   const exchange=async bytes=>{const response=once(s,'data');s.write(bytes);return (await response)[0];};
   if(type==='dynamic'){
    assert.deepEqual(await exchange(Buffer.from([5,1,0])),Buffer.from([5,0]));const req=Buffer.from([5,1,0,1,127,0,0,1,0,0]);req.writeUInt16BE(echo.address().port,8);assert.equal((await exchange(req))[1],0);
   }
   assert.equal((await exchange('ROUTING_UI_OK')).toString(),'ROUTING_UI_OK');
   if(type==='dynamic')await page.screenshot({path:'research/harbor-forwardings.png'});
   await card.getByRole('button',{name:'Stop',exact:true}).click();await card.getByRole('button',{name:'Start',exact:true}).waitFor();s.destroy();
  }
  const data=await page.evaluate(()=>window.harbor.invoke('vault:read'));assert.equal(data.forwardings.length,3);assert.equal(data.hosts.find(h=>h.label==='Private application').jumpHostId,jump.host.id);assert(!JSON.stringify(data).includes('111111'));assert(!JSON.stringify(data).includes('222222'));
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-routing-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('button',{name:'Port Forwarding',exact:true}).click();assert.equal(await page.locator('.forward-card').getByRole('button',{name:'Start',exact:true}).count(),3);
  assert.deepEqual(errors,[]);console.log('PASS: saved jump host with per-hop MFA, routed SFTP, local/remote/SOCKS forwarding UI, assigned ports, stop and encrypted persistence.');
 } finally {await app?.close();for(const s of sockets)s.destroy();await new Promise(r=>echo.close(r));await jump.close();await target.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1)});
