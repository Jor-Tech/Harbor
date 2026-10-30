'use strict';
// Reproducible product screenshot with synthetic hosts; never connect to a server.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-readme-'));let app;
 try{
  app=await electron.launch({args:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});
  const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.setViewportSize({width:1440,height:900});
  await page.getByRole('heading',{name:'Create your personal vault'}).waitFor();const password=randomUUID();
  await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await page.evaluate(async()=>{
   await window.harbor.invoke('settings:save',{hostsHomeView:'all',theme:'dark'});
   for(const [label,color,hosts] of [
    ['Production','blue',[['Web app','web','deploy','web, production'],['API server','api','deploy','api, production'],['Database','db','postgres','database']]],
    ['Staging','purple',[['Staging app','staging','deploy','web, staging']]],
    ['Infrastructure','green',[['Build runner','build','runner','ci'],['Bastion','bastion','admin','gateway']]]
   ]){
    const data=await window.harbor.invoke('entity:save',{collection:'groups',item:{label,color}});const groupId=data.groups.find(g=>g.label===label).id;
    for(const [hostLabel,host,username,tags] of hosts)await window.harbor.invoke('entity:save',{collection:'hosts',item:{label:hostLabel,address:host+'.example.test',username,tags,color,port:22,groupId,favorite:host==='web'||host==='api'}});
   }
  });
  // Reload the view from the saved synthetic vault, using normal application UI.
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill(password);await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();await page.locator('.host-card').first().waitFor();
  const count=await page.locator('.host-card').count();if(count!==6)throw new Error(`Expected six example hosts, got ${count}`);
  await page.mouse.move(1430,890);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await fs.mkdir(path.join(__dirname,'../docs/images'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../docs/images/harbor-workspace.png')});console.log('Captured synthetic workspace; no SSH connections or personal data.');
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
