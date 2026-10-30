'use strict';
const {_electron:electron}=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'h-mcp-management-'));let app,page;
 try{
  const launch=()=>electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu'],env:{...process.env,HARBOR_DATA_DIR:dir}});app=await launch();
  page=await app.firstWindow();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-management-fixture');await page.getByLabel('Confirm password',{exact:true}).fill('Harbor-management-fixture');await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await page.evaluate(()=>window.harbor.invoke('entity:save',{collection:'hosts',item:{id:'fixture',label:'Management test host',address:'127.0.0.1',port:2222,username:'test'}}));
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-management-fixture');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manage local MCP',exact:true}).click();
  for(const name of ['Automation client','Other client']){await page.getByLabel('Client name',{exact:true}).fill(name);await page.getByRole('button',{name:'Pair local client',exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();}
  const state=()=>page.evaluate(()=>window.harbor.invoke('mcp:status')),paired=(await state()).clients,[a,b]=paired;
  await page.getByRole('button',{name:/^Manage client Automation client/}).click();await page.getByLabel('Management test host',{exact:true}).check();
  for(const name of ['Open SSH connections','Run commands and share output','List remote folders','Read remote text files','Write remote text files'])await page.getByLabel(name,{exact:true}).check();await page.getByRole('button',{name:'Save permissions',exact:true}).click();
  await page.getByRole('tab',{name:'Headless (Experimental)',exact:true}).click();const add=page.getByRole('button',{name:'Add headless rule',exact:true}),action=page.getByLabel('Headless action',{exact:true}),scope=page.getByLabel('Headless scope',{exact:true});
  await action.selectOption('harbor_exec');assert.equal(await scope.inputValue(),'exact');assert.equal(await scope.locator('option[value=all-commands]').getAttribute('disabled'),'');assert(await add.isDisabled());
  async function addRule(tool,scopeValue,value,count){
   await action.selectOption(tool);if(scopeValue!=='exact'){await page.getByLabel('Advanced: allow broader unattended access',{exact:true}).check();await scope.selectOption(scopeValue);}
   if(value!==undefined)await page.getByLabel(tool==='harbor_exec'?'Exact command':scopeValue==='directory'?'Remote folder':'Exact remote path',{exact:true}).fill(value);
   const consent=page.locator('.mcp-headless form input[type=checkbox]').last();await consent.check();assert(await consent.isChecked());
   await add.click();await page.waitForFunction(async count=>(await window.harbor.invoke('mcp:status')).clients.find(c=>c.name==='Automation client').automations?.length===count,count);
   // Persisted state arrives before the async submit handler resets the form.
   await page.waitForFunction(()=>{
    const form=document.querySelector('.mcp-headless form');
    return form.querySelector('[aria-label="Headless scope"]').value==='exact'&&[...form.querySelectorAll('input[type=checkbox]')].every(input=>!input.checked);
   });
  }
  await addRule('harbor_exec','all-commands',undefined,1);assert.equal(await scope.inputValue(),'exact');assert(!(await page.getByLabel('Advanced: allow broader unattended access',{exact:true}).isChecked()));
  await addRule('harbor_list_files','directory','/work',2);await addRule('harbor_read_file','all-paths',undefined,3);await addRule('harbor_write_file','exact','/work/output.txt',4);await addRule('harbor_write_file','all-paths',undefined,5);
  const saved=(await state()).clients.find(c=>c.id===a.id).automations;assert(saved.every(r=>r.binding?.length===64&&r.destination==='test@127.0.0.1:2222'));assert.equal(saved[3].tool,'harbor_write_file');assert.equal(saved[4].scope,'all-paths');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:960,height:760}));assert(await page.evaluate(()=>{const p=document.querySelector('.page-content');return p.scrollWidth<=p.clientWidth+1}));await page.screenshot({path:'research/harbor-mcp-headless-scopes.png'});
  // Scope changes revoke an already checked confirmation.
  await action.selectOption('harbor_read_file');await page.getByLabel('Exact remote path',{exact:true}).fill('/one');const consent=page.locator('.mcp-headless form input[type=checkbox]').last();await consent.check();await page.getByLabel('Exact remote path',{exact:true}).fill('/two');assert(!(await consent.isChecked()));assert(await add.isDisabled());
  // Seed metadata through a normal GUI management action; no direct access to backend objects.
  await page.evaluate(async ids=>{for(const id of ids)await window.harbor.invoke('mcp:disconnect',{id})},[a.id,b.id]);await page.getByRole('tab',{name:'Activity',exact:true}).click();await page.locator('.mcp-log-row').first().waitFor();await page.getByLabel('Filter activity by client',{exact:true}).selectOption(a.id);
  await page.evaluate(()=>{window.confirm=()=>false});await page.getByRole('button',{name:'Clear client activity',exact:true}).click();assert((await state()).audit.some(r=>r.clientId===a.id));
  await page.evaluate(()=>{window.confirm=()=>true});await page.getByRole('button',{name:'Clear client activity',exact:true}).click();await page.getByRole('heading',{name:'No activity yet',exact:true}).waitFor();assert((await state()).audit.every(r=>r.clientId===b.id));
  await page.getByLabel('Filter activity by client',{exact:true}).selectOption('all');await page.locator('.mcp-log-row').first().waitFor();assert((await page.locator('.mcp-log-rows').innerText()).includes('Other client'));await page.screenshot({path:'research/harbor-mcp-activity-clear.png'});
  await page.getByRole('button',{name:'Clear all activity',exact:true}).click();await page.getByRole('heading',{name:'No activity yet',exact:true}).waitFor();assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'mcp-audit.json'),'utf8')),[]);
  await page.evaluate(id=>window.harbor.invoke('mcp:disconnect',{id}),b.id);await page.locator('.mcp-log-row').first().waitFor();assert.equal((await state()).audit.length,1);
  await page.getByRole('tab',{name:'Clients',exact:true}).click();await page.getByRole('button',{name:/^Manage client Other client/}).click();await page.getByRole('tab',{name:'Client setup',exact:true}).click();
  const remove=page.getByRole('button',{name:'Remove client',exact:true});await remove.waitFor();assert(await remove.isVisible());assert.equal(await remove.locator('xpath=ancestor::details').count(),0);await page.screenshot({path:'research/harbor-mcp-client-remove.png'});
  await page.evaluate(()=>{window.confirm=()=>false});await remove.click();assert.equal((await state()).clients.length,2);await page.evaluate(()=>{window.confirm=()=>true});await remove.click();await page.getByRole('heading',{name:'Automation client',exact:true}).waitFor();assert.equal((await state()).clients.length,1);assert.equal((await state()).clients[0].automations.length,5);await assert.rejects(fs.access(b.config.mcpServers.harbor.args.at(-1)),{code:'ENOENT'});
  // Restart Harbor: cleared entries stay absent; removal history is retained.
  await app.close();app=await launch();page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));await page.getByLabel('Vault password',{exact:true}).fill('Harbor-management-fixture');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manage local MCP',exact:true}).click();await page.getByRole('tab',{name:'Activity',exact:true}).click();await page.locator('.mcp-log-row').first().waitFor();assert.equal((await state()).audit.length,2);assert((await state()).audit.every(r=>r.clientId===b.id));assert.deepEqual(errors,[]);
  console.log('PASS: visible Remove client with cancel/confirm and credential deletion; client/all activity clearing with cancellation, continued logging and persistence; headless exact/any commands, folder/any file scopes and writes, account binding, consent reset, narrow layout and client isolation.');
 }catch(error){await page?.screenshot({path:'research/harbor-mcp-management-failure.png'}).catch(()=>{});console.error(await page?.locator('body').innerText().catch(()=>''));throw error;}finally{await app?.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
