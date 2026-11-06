'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createTerminalServer}=require('../tests/helpers/terminal-server.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harbor-terminal-ui-')),server=await createTerminalServer();let app;
 try{
  app=await electron.launch({executablePath:process.env.HARBOR_EXECUTABLE||undefined,args:[...(process.env.HARBOR_EXECUTABLE?['--disable-gpu']:['.','--disable-gpu']),...(process.env.HARBOR_TEST_X11==='1'?['--ozone-platform=x11']:[])],env:{...process.env,HARBOR_DATA_DIR:dir}});
  await app.evaluate(async({clipboard})=>{globalThis.harborTestClipboard=await clipboard.read()});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByLabel('Vault password',{exact:true}).fill('Harbor-terminal-test-password');await page.getByLabel('Confirm password',{exact:true}).fill('Harbor-terminal-test-password');await page.getByRole('button',{name:'Create vault',exact:true}).click();await page.getByRole('heading',{name:'Hosts',exact:true}).waitFor();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})});
  await page.evaluate(async host=>{await window.harbor.invoke('entity:save',{collection:'hosts',item:{...host,password:'test-password'}})},server.host);
  await page.getByTitle('Lock vault',{exact:true}).click();await page.getByLabel('Vault password',{exact:true}).fill('Harbor-terminal-test-password');await page.getByRole('button',{name:'Unlock vault',exact:true}).click();
  await page.locator('.host-card').getByRole('button',{name:'Connect',exact:true}).click();
  const pane=page.locator('.terminal-pane:visible');await pane.getByText('Connected',{exact:true}).waitFor();assert.equal(await pane.getByLabel('Auto reconnect this tab').isChecked(),false);
  // Search real output, including wrapped and older scrollback lines.
  for(const s of server.shells)s.write('Needle needle needles\r\n'+'x'.repeat(250)+'WRAPPED_TOKEN\r\n'+Array.from({length:90},(_,i)=>`line ${i}\r\n`).join(''));
  await pane.locator('.xterm-helper-textarea').focus();await page.keyboard.press(process.platform==='darwin'?'Meta+f':'Control+Shift+f');await pane.getByLabel('Find in terminal',{exact:true}).fill('needle');
  await pane.getByText('1 of 3',{exact:true}).waitFor();await pane.getByRole('button',{name:'Next match',exact:true}).click();await pane.getByText('2 of 3',{exact:true}).waitFor();
  await pane.getByLabel('Find in terminal',{exact:true}).press('Shift+Enter');await pane.getByText('1 of 3',{exact:true}).waitFor();
  await pane.getByRole('button',{name:'Match case',exact:true}).click();await pane.getByText('1 of 2',{exact:true}).waitFor();await pane.getByRole('button',{name:'Whole word',exact:true}).click();await pane.getByText('1 of 1',{exact:true}).waitFor();
  await pane.getByLabel('Find in terminal',{exact:true}).fill('absent-token');await pane.getByText('No matches',{exact:true}).waitFor();
  await pane.getByRole('button',{name:'Whole word',exact:true}).click();await pane.getByLabel('Find in terminal',{exact:true}).fill('WRAPPED_TOKEN');await pane.getByText('1 of 1',{exact:true}).waitFor();
  await pane.locator('.xterm-helper-textarea').focus();
  // Search selects actual xterm buffer text; copy must use that selection,
  // never send the shortcut to SSH, and leave ordinary Ctrl+C alone.
  const copyShortcut=process.platform==='darwin'?'Meta+c':'Control+Shift+c';
  await app.evaluate(({clipboard})=>clipboard.writeText('COPY_SENTINEL'));
  await page.keyboard.press(copyShortcut);
  for(let i=0;i<50&&!await app.evaluate(async({clipboard})=>(await clipboard.readText())==='WRAPPED_TOKEN');i++)await page.waitForTimeout(100);
  assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'WRAPPED_TOKEN');assert.equal(server.received.join(''),'');
  await pane.getByLabel('Find in terminal',{exact:true}).press('Escape');assert.equal(await pane.getByLabel('Find in terminal',{exact:true}).count(),0);
  await page.keyboard.press('Control+c');await page.waitForTimeout(100);assert.equal(server.received.join(''),'\x03');server.received.length=0;
  await app.evaluate(({clipboard})=>clipboard.writeText('NO_SELECTION_SENTINEL'));
  await page.keyboard.press(copyShortcut);await page.waitForTimeout(100);assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'NO_SELECTION_SENTINEL');assert.equal(server.received.join(''),'');
  await app.evaluate(({clipboard})=>clipboard.writeText('PASTE_CHECK'));
  await page.keyboard.press(process.platform==='darwin'?'Meta+v':'Control+Shift+v');
  for(let i=0;i<50&&server.received.join('')!=='PASTE_CHECK';i++)await page.waitForTimeout(100);
  assert.equal(server.received.join(''),'PASTE_CHECK');server.received.length=0;
  await page.keyboard.type('ONLY_ONCE');await page.waitForTimeout(100);assert.equal(server.received.join(''),'ONLY_ONCE');
  for(const s of server.shells)s.write('\x1b[?1049hFULL_SCREEN_APP');
  server.drop();await pane.getByText('Disconnected',{exact:true}).waitFor();await pane.locator('.xterm-helper-textarea').focus();await page.keyboard.type('DO_NOT_REPLAY');
  await pane.getByRole('button',{name:'Reconnect',exact:true}).click();await pane.getByText('Connected',{exact:true}).waitFor();assert.equal(await page.locator('.terminal-pane').count(),1);assert.equal(server.received.join(''),'ONLY_ONCE');
  await pane.getByRole('button',{name:'Search terminal',exact:true}).click();await pane.getByLabel('Find in terminal',{exact:true}).fill('Needle');await pane.getByText('1 of 1',{exact:true}).waitFor();
  await page.screenshot({path:'research/harbor-terminal-search.png'});await pane.getByRole('button',{name:'Close terminal search',exact:true}).click();
  await pane.getByLabel('Auto reconnect this tab').click();await pane.locator('.terminal-connection input:checked').waitFor();server.drop();await pane.getByText(/Reconnecting in/).waitFor();await page.screenshot({path:'research/harbor-terminal-reconnect.png'});await pane.getByText('Connected',{exact:true}).waitFor();assert.equal(server.state.connections,3);
  // A new MFA challenge is shown on reconnect and can be cancelled.
  server.state.otp=true;server.drop();await page.getByRole('heading',{name:'SSH verification',exact:true}).waitFor();await page.getByLabel('Verification code',{exact:true}).fill('123456');await page.getByRole('button',{name:'Continue',exact:true}).click();await pane.getByText('Connected',{exact:true}).waitFor();
  server.drop();await page.getByRole('heading',{name:'SSH verification',exact:true}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();await pane.getByText('Disconnected',{exact:true}).waitFor();const count=server.state.connections;await page.waitForTimeout(2200);assert.equal(server.state.connections,count);
  server.state.otp=false;await pane.getByRole('button',{name:'Reconnect',exact:true}).click();await pane.getByText('Connected',{exact:true}).waitFor();server.exit();await pane.getByText('Session ended',{exact:true}).waitFor();const exited=server.state.connections;await page.waitForTimeout(2200);assert.equal(server.state.connections,exited);
  // Split panes retain independent search UI; local shells can restart in place.
  await page.getByRole('button',{name:'Split right',exact:true}).click();const local=page.locator('.terminal-pane').filter({hasText:'LOCAL'});await local.getByText('Connected',{exact:true}).waitFor();await local.getByRole('button',{name:'Search terminal',exact:true}).click();assert.equal(await local.getByLabel('Find in terminal',{exact:true}).count(),1);
  assert.equal(await page.locator('.terminal-pane').filter({hasText:'SSH'}).getByLabel('Find in terminal',{exact:true}).count(),0);
  await local.getByRole('button',{name:'Close terminal search',exact:true}).click();await local.getByRole('button',{name:'Disconnect',exact:true}).click();await local.getByRole('button',{name:'Restart shell',exact:true}).click();await local.getByText('Connected',{exact:true}).waitFor();assert.equal(await page.locator('.terminal-pane').count(),2);
  // Lock during a scheduled retry clears all tabs and prevents a new connection.
  const ssh=page.locator('.terminal-pane').filter({hasText:'SSH'});await ssh.getByRole('button',{name:'Reconnect',exact:true}).click();await ssh.getByText('Connected',{exact:true}).waitFor();server.drop();await ssh.getByText(/Reconnecting in/).waitFor();await page.getByTitle('Lock vault',{exact:true}).click();await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();const locked=server.state.connections;await page.waitForTimeout(2200);assert.equal(server.state.connections,locked);assert.equal(await page.locator('.terminal-pane').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS: terminal copy/paste, Ctrl+C interrupt, search, shortcuts, scrollback, manual/automatic reconnect, fresh MFA, cancellation, exit, split panes, local restart and lock.');
 }catch(error){const p=await app?.firstWindow();if(p){console.log('Terminal UI:',await p.locator('.terminal-search,.terminal-connection,.terminal-disconnected').allTextContents());await p.screenshot({path:'research/harbor-terminal-failure.png'})}throw error;}finally{if(app)await app.evaluate(async({clipboard})=>{if(globalThis.harborTestClipboard)await clipboard.write(globalThis.harborTestClipboard)}).catch(()=>{});await app?.close();await server.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
