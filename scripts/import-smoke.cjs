'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-import-ui-'));let app;
 const config=path.join(dir,'config');await fs.writeFile(config,'Host jump\n HostName jump.example.test\n User admin\nHost target\n HostName target.internal.test\n ProxyJump jump\n IdentityFile ~/.ssh/private-not-read\nHost blocked\n ProxyCommand example-command %h %p\nHost *\n Port 2222\nInclude missing-config\nMatch exec "never-run-this"\n User ignored\n');
 try{
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-import-test-password');await page.getByLabel('Confirm password',{exact:true}).fill('Harbor-import-test-password');await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},config);
  await page.getByRole('button',{name:'Import SSH config',exact:true}).click();await page.getByRole('heading',{name:'Import SSH configuration',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Import blocked',{exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Import 2 hosts',exact:true}).isDisabled(),true);
  await page.getByLabel('Authentication for jump',{exact:true}).selectOption('1password');await page.getByLabel('Authentication for target',{exact:true}).selectOption('system');
  await page.getByText('1 option needs review',{exact:true}).first().click().catch(()=>{});
  await page.screenshot({path:'research/harbor-ssh-import.png'});
  await page.getByLabel('I reviewed the unsupported options and will configure anything missing before connecting.').check();await page.getByRole('button',{name:'Import 2 hosts',exact:true}).click();await page.getByRole('heading',{name:'Import SSH configuration',exact:true}).waitFor({state:'hidden'});
  const d=await page.evaluate(()=>window.harbor.invoke('vault:read'));assert.equal(d.hosts.length,2);assert.equal(d.hosts[0].agentProvider,'1password');assert.equal(d.hosts[1].agentProvider,'system');assert.equal(d.hosts[1].jumpHostId,d.hosts[0].id);assert.equal(d.hosts[1].port,2222);assert.equal(d.keys.length,0);
  await page.getByRole('button',{name:'Import SSH config',exact:true}).click();await page.getByRole('heading',{name:'Import SSH configuration',exact:true}).waitFor();assert.equal(await page.getByLabel('Import jump',{exact:true}).isChecked(),false);assert.equal(await page.getByLabel('Import target',{exact:true}).isChecked(),false);
  await page.getByLabel('Import target',{exact:true}).check();await page.getByLabel('I reviewed the unsupported options and will configure anything missing before connecting.').check();assert.equal(await page.getByRole('button',{name:'Import 1 host',exact:true}).isDisabled(),true);await page.getByLabel('Add selected duplicates as additional hosts.').check();await page.getByRole('button',{name:'Import 1 host',exact:true}).click();await page.getByRole('heading',{name:'Import SSH configuration',exact:true}).waitFor({state:'hidden'});
  const imported=await page.evaluate(()=>window.harbor.invoke('vault:read'));assert.equal(imported.hosts.length,3);assert.equal(imported.hosts[2].jumpHostId,d.hosts[0].id);
  // A preview cannot survive lock/unlock or be replayed after import.
  const preview=await page.evaluate(()=>window.harbor.invoke('sshConfig:preview'));await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-import-test-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  const expired=await page.evaluate(async p=>{try{await window.harbor.invoke('sshConfig:import',{previewId:p.id,selections:[{id:p.entries[0].id}],allowDuplicates:true,acknowledgeWarnings:true});return false}catch(e){return /expired/.test(e.message)}},preview);assert.equal(expired,true);assert.deepEqual(errors,[]);
  console.log('PASS: SSH config preview, route/auth choices, warnings, blocked options, duplicate selection, atomic import and lock invalidation.');
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
