const { app, BrowserWindow, ipcMain, dialog, powerMonitor, clipboard, Menu, shell, Tray } = require('electron');
const {RELEASES_URL,releaseInfo}=require('./releases.cjs');
const {UpdateChecker}=require('./update-checker.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { Vault } = require('./vault.cjs');
const { ConnectionManager } = require('./connections.cjs');
const { TerminalSessions } = require('./terminal-sessions.cjs');
const {previewConfig,applyImport}=require('./ssh-config.cjs');
const {FolderSync}=require('./folder-sync.cjs');
const {equal}=require('./vault-conflicts.cjs');
const {withMetadata}=require('./entity-metadata.cjs');
const {resolveHost,resolveRoute,groupDefaults,deleteGroup,validateWorkspace}=require('./host-model.cjs');
const {forwardConfig}=require('./forwarding.cjs');
const {Files,filename,absolute}=require('./files.cjs');
const {McpAccess}=require('./mcp/access.cjs');
const { AuthPrompts } = require('./auth-prompts.cjs');
app.setName('Harbor');
if (process.env.HARBOR_DATA_DIR) app.setPath('userData', path.resolve(process.env.HARBOR_DATA_DIR));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
let quitting = false, retentionTimer, mcp, tray, releaseRuntime, updates;
let sshImportPreview, syncer, syncEpoch=0;
let win, vault, connections, terminals, files, authPrompts, timer, touchGeneration = 0, lockGeneration = 0, device = {}, mutation = Promise.resolve();
const assertGeneration = value => { if (value !== lockGeneration) throw new Error('Vault was locked during the operation'); };
const viewData = d => ({...d,effectiveHosts:Object.fromEntries(d.hosts.map(h=>[h.id,resolveHost(d,h)])),groupDefaults:Object.fromEntries(d.groups.map(g=>[g.id,groupDefaults(d.groups,g.id)])),settings:{...d.settings,syncFolder:device.syncFolder || '',autoSync:device.autoSync===true}});
const send = (event, data) => {
  if (event === 'terminal:status' && ['closed','error','waiting','cancelling'].includes(data.status)) files?.cancelSession(data.id);
  if (win && !win.isDestroyed()) win.webContents.send(event, data);
};
const serialize = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
function startBackupCleanup() {
  clearInterval(retentionTimer);
  const generation=lockGeneration;
  const check=()=>serialize(async()=>{assertGeneration(generation);return vault.retention.cleanup(true)}).catch(error=>{if(generation===lockGeneration)vault.retention.lastResult={at:Date.now(),deleted:0,error:error.message}});
  void check();retentionTimer=setInterval(check,60*60_000);retentionTimer.unref();
}

async function touch() {
  const generation=++touchGeneration;clearTimeout(timer);
  try { const d = await vault.read(); if(generation!==touchGeneration||d.settings.autoLockMinutes===0)return;const minutes = Math.max(1, Math.min(240, Number(d.settings.autoLockMinutes) || 15)); timer = setTimeout(lock, minutes * 60_000); } catch {}
}
function lock() { ++touchGeneration; mcp?.pause(); clearInterval(retentionTimer); sshImportPreview=null; ++syncEpoch; syncer?.configure({unlocked:false}); ++lockGeneration; clearTimeout(timer); authPrompts?.cancelAll(); files?.cancelAll(); connections?.closeAll({preservePersistent:true,vaultId:vault?.identity}); vault?.lock(); send('vault:locked', {}); }
async function edit(fn) { return serialize(async () => { const d = await vault.read(); await fn(d); const saved=await vault.save(d); syncer?.schedule(); return saved; }); }
async function saveDevice(next) {
  const file=path.join(app.getPath('userData'),'device.json'),temp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,JSON.stringify(next),{mode:0o600});await fs.rename(temp,file);device=next;}finally{await fs.rm(temp,{force:true})}
}
async function synchronize() {
  const generation=lockGeneration,epoch=syncEpoch,folder=device.syncFolder;
  if(!folder)throw new Error('Choose a sync folder first');
  const check=()=>{assertGeneration(generation);if(epoch!==syncEpoch)throw new Error('Sync settings changed; try again.')};
  const result=await serialize(async()=>{check();const stat=await fs.stat(folder).catch(()=>null);if(!stat?.isDirectory())throw new Error('The sync folder is unavailable. Reconnect it, then choose Sync now.');check();return vault.sync(folder)});
  check();const data=viewData(await vault.read());check();
  if(result.status==='pulled')mcp?.pause();
  if(result.status==='pulled')send('vault:changed',data);
  return {result,data};
}
function credential(d, host) {
  const provider=host.agentProvider || (host.useAgent?'system':'none');
  const base={username:host.username,password:host.password};
  if(provider!=='none')return {...base,useAgent:true,agentProvider:provider,agentSocket:host.agentSocket,agentFingerprint:host.agentFingerprint};
  const key=d.keys.find(k=>k.id===host.keyId);
  if(host.keyId&&!key)throw new Error('The selected SSH key was not found');
  return key?{...base,privateKey:key.privateKey,passphrase:key.passphrase}:base;
}
function required(value, name, max = 1024) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} is required`); return value; }
function route(d,host){return resolveRoute(d,host).map(h=>({host:h,credential:credential(d,h)}));}
function validateEntity(collection, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid item');
  required(item.label, 'Name', 200);
  if (collection === 'hosts') { required(item.address, 'Address', 253); if (/\s|\0/.test(item.address)) throw new Error('Enter a hostname or IP address'); if (!Number.isInteger(Number(item.port)) || item.port < 1 || item.port > 65535) throw new Error('Port must be between 1 and 65535'); }
  if (['hosts','groups'].includes(collection)&&item.color!==undefined&&!['blue','green','purple','orange','pink'].includes(item.color))throw new Error('Invalid color');
  if (collection === 'hosts' && item.persistentSession !== undefined && typeof item.persistentSession !== 'boolean') throw new Error('Invalid persistent session preference');
  if (collection === 'keys') required(item.privateKey, 'Private key', 100000);
  if (collection === 'snippets') required(item.command, 'Command', 100000);
  if (collection === 'forwardings') { required(item.hostId, 'SSH host'); forwardConfig(item); }
}
async function invoke(action, args = {}, generation = lockGeneration) {
  switch (action) {
    case 'mcp:audit:clear': return mcp.clearAudit(args.clientId,args.confirm);
    case 'mcp:rules': return mcp.saveRules(args.id,args.rules,args.confirm);
    case 'mcp:approval:preview': return mcp.previewApproval(args.id,args.hostId);
    case 'mcp:approval:full': return mcp.addFullApproval(args.id,args.hostId,args.confirm,args.binding);
    case 'mcp:approval:add': return mcp.addApproval(args.id,args.rule,args.confirm,args.binding);
    case 'mcp:approval:clear-host': return mcp.clearHostApprovals(args.id,args.hostId);
    case 'mcp:approval:remove': return mcp.removeApproval(args.id,args.approvalId);
    case 'mcp:background': return mcp.setBackground(args.enabled);
    case 'mcp:answer': await vault.read(); return mcp.answer(args.id,args.approved,args.share,args.remember,args.writePermission);
    case 'mcp:status': await vault.read(); return mcp.snapshot();
    case 'mcp:enabled': return mcp.setEnabled(args.enabled);
    case 'mcp:resume': return mcp.resume();
    case 'mcp:create': return mcp.create(args);
    case 'mcp:rename': return mcp.rename(args.id,args.name);
    case 'mcp:update': return mcp.update(args.id,args.policy);
    case 'mcp:revoke': return mcp.revoke(args.id);
    case 'mcp:disconnect': await vault.read(); return mcp.disconnectClient(args.id);
    case 'updates:status': return updates.snapshot();
    case 'updates:check': return updates.check();
    case 'updates:configure': return serialize(()=>updates.configure(args));
    case 'updates:open': await shell.openExternal(updates.state.phase==='available'?updates.state.latest.url:RELEASES_URL);return true;
    case 'releases:info': return releaseInfo({version:app.getVersion(),platform:process.platform,arch:process.arch,packaged:app.isPackaged});
    case 'releases:open': await shell.openExternal(RELEASES_URL); return true;
    case 'auth:answer': await vault.read(); assertGeneration(generation); authPrompts.answer(args.id,args.answers); return true;
    case 'vault:status': return vault.status();
    case 'vault:create': { const d = await serialize(() => { assertGeneration(generation); return vault.create(args.password); }); syncer.configure({enabled:device.autoSync===true,unlocked:true}); startBackupCleanup(); touch(); return d; }
    case 'vault:unlock': { const d = await serialize(() => { assertGeneration(generation); return vault.unlock(args.password); }); assertGeneration(generation); const restoredTerminals=terminals.restoreSuspended(d.hosts,vault.identity); syncer.configure({enabled:device.autoSync===true,unlocked:true}); startBackupCleanup(); touch(); return {...d,restoredTerminals}; }
    case 'vault:lock': lock(); return true;
    case 'vault:read': return vault.read();
    case 'vault:security': return vault.encryptionInfo();
    case 'vault:upgradeEncryption': {
      if (args.confirm !== true) throw new Error('Confirm the protection upgrade first.');
      const result = await serialize(() => { assertGeneration(generation); return vault.upgradeEncryption(args.password); });
      assertGeneration(generation); syncer.schedule(); return result;
    }
    case 'vault:retention': return serialize(() => { assertGeneration(generation); return vault.retention.info(); });
    case 'vault:saveRetention': return serialize(() => { assertGeneration(generation); return vault.retention.setPolicy(args.policy,args.token,args.confirm); });
    case 'vault:keepBackup': return serialize(() => { assertGeneration(generation); return vault.backupManagement.setKeep(device.syncFolder,args.token,args.id,args.keep); });
    case 'vault:managedBackups': return serialize(() => { assertGeneration(generation); return vault.backupManagement.list(args.scope,device.syncFolder); });
    case 'vault:previewManagedBackup': return serialize(() => { assertGeneration(generation); return vault.backupManagement.preview(args.scope,device.syncFolder,args.token,args.id,args.password); });
    case 'vault:deleteBackups': return serialize(() => { assertGeneration(generation); return vault.backupManagement.delete(args.scope,device.syncFolder,args.token,args.ids,args.confirm); });
    case 'vault:backups': return vault.listBackups();
    case 'vault:backup': return serialize(() => { assertGeneration(generation); return vault.createBackup(); });
    case 'vault:previewRecovery': return serialize(() => { assertGeneration(generation); return vault.previewRecovery(args.id,args.password); });
    case 'vault:restoreBackup': { mcp?.pause();
      if (args.confirm !== true) throw new Error('Confirm replacement before restoring a backup.');
      assertGeneration(generation); ++syncEpoch; syncer.configure({enabled:false});
      const d = await serialize(async () => {
        assertGeneration(generation);
        await saveDevice({...device,autoSync:false}); assertGeneration(generation);
        sshImportPreview=null; authPrompts.cancelAll(); files.cancelAll(); connections.closeAll();
        try {
          const data = await vault.restoreBackup(args.id,args.password,args.token);
          assertGeneration(generation); return data;
        } catch (error) {
          // Sync remains paused on failure too. Keep an unlocked settings view
          // in step with the persisted device preference.
          try { const data=await vault.read(); assertGeneration(generation); send('vault:changed',viewData(data)); } catch {}
          throw error;
        }
      });
      syncer.configure({enabled:false,unlocked:true}); startBackupCleanup(); touch(); return d;
    }
    case 'activity': touch(); return true;
    case 'entity:save': {
      const { collection, item } = args; if(['hosts','groups','keys'].includes(collection))mcp?.pause(); if (!['hosts','groups','keys','snippets','forwardings','workspaces'].includes(collection)) throw new Error('Unknown collection'); validateEntity(collection,item); if(collection==='workspaces')validateWorkspace(item);
      return edit(d => { const id=item.id||randomUUID(),index=d[collection].findIndex(x=>x.id===id),saved=withMetadata({...item,id},d[collection][index]); if(item.id&&args.expected&&!equal(d[collection][index],args.expected))throw new Error('This item changed since you opened it. Close and reopen the editor before saving.'); if (index < 0) d[collection].push(saved); else d[collection][index] = saved; });
    }
    case 'entity:delete': {
      const { collection, id } = args; if(['hosts','groups','keys'].includes(collection))mcp?.pause(); if (!['hosts','groups','keys','snippets','forwardings','workspaces'].includes(collection)) throw new Error('Unknown collection');
      return edit(d => { if(args.expected&&!equal(d[collection].find(x=>x.id===id),args.expected))throw new Error('This item changed. Refresh before deleting it.'); if(collection==='groups'){deleteGroup(d,id);return;} d[collection] = d[collection].filter(x => x.id !== id);  if(collection==='keys'){d.hosts.forEach(h=>{if(h.keyId===id)h.keyId=''});d.groups.forEach(g=>{if(g.defaults?.auth?.keyId===id)g.defaults.auth.keyId=''})} });
    }
    case 'sshConfig:preview': {
      await vault.read();
      const selected=await dialog.showOpenDialog(win,{title:'Import SSH configuration',defaultPath:path.join(require('node:os').homedir(),'.ssh','config'),properties:['openFile']});
      if(selected.canceled)return null; assertGeneration(generation);
      const handle=await fs.open(selected.filePaths[0],require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);
      let text;try{const stat=await handle.stat();if(!stat.isFile()||stat.size>1024*1024)throw new Error('Choose an SSH config text file up to 1 MiB');text=await handle.readFile('utf8')}finally{await handle.close()}
      const d=await vault.read();assertGeneration(generation);
      sshImportPreview={...previewConfig(text,d,{source:path.basename(selected.filePaths[0])}),id:randomUUID(),expires:Date.now()+15*60_000};
      return sshImportPreview;
    }
    case 'sshConfig:import': { mcp?.pause();
      const preview=sshImportPreview;
      if(!preview||preview.id!==args.previewId||preview.expires<Date.now())throw new Error('Import preview expired. Choose the config file again.');
      const d=await edit(data=>{assertGeneration(generation);if(sshImportPreview!==preview)throw new Error('Import preview expired');const result=applyImport(preview,data,args.selections,args);for(const h of result.hosts)validateEntity('hosts',h);sshImportPreview=null;data.hosts=result.hosts;});
      if(sshImportPreview===preview)sshImportPreview=null;return d;
    }
    case 'settings:save': { const saved=await edit(d => { for(const [key,allowed] of Object.entries({hostsHomeView:['all','groups'],hostSort:['name','group','address','created','updated','connected'],hostSortDirection:['asc','desc']})){if(key in args){if(!allowed.includes(args[key]))throw new Error('Invalid host browsing preference');d.settings[key]=args[key];}} if ('theme' in args) { if (!['dark','light'].includes(args.theme)) throw new Error('Invalid theme'); d.settings.theme=args.theme; } if ('fontSize' in args) { if (![12,13,14,15,16,18,20,24].includes(args.fontSize)) throw new Error('Invalid font size'); d.settings.fontSize=args.fontSize; } if ('autoLockMinutes' in args) { if (![0,1,5,15,30,60].includes(args.autoLockMinutes)) throw new Error('Invalid auto lock interval'); d.settings.autoLockMinutes=args.autoLockMinutes; } });if('autoLockMinutes' in args)await touch();return saved; }
    case 'knownHost:forget': { mcp?.pause(); await vault.read(); const answer=await dialog.showMessageBox(win,{type:'warning',message:'Forget this server identity?',detail:`${args.id}\nOnly do this after independently verifying a changed server key. Active connections will close.`,buttons:['Cancel','Forget'],defaultId:0,cancelId:0}); assertGeneration(generation); if(answer.response!==1)return null; connections.closeAll(); return edit(d=>{delete d.knownHosts[args.id]}); }
    case 'vault:password': { mcp?.pause(); await serialize(() => { assertGeneration(generation); return vault.changePassword(args.oldPassword,args.newPassword); }); const data=await vault.read(); assertGeneration(generation); send('vault:changed',viewData(data)); syncer.schedule(); return true; }
    case 'vault:export': { await vault.read(); const selected = await dialog.showSaveDialog(win,{title:'Export encrypted vault',defaultPath:'Harbor-vault.hbr',filters:[{name:'Encrypted Harbor vault',extensions:['hbr']}]}); if (selected.canceled) return null; await serialize(() => vault.exportTo(selected.filePath)); return selected.filePath; }
    case 'vault:import': { mcp?.pause();
      const selected = await dialog.showOpenDialog(win,{title:'Import encrypted Harbor vault',properties:['openFile'],filters:[{name:'Encrypted Harbor vault',extensions:['hbr','harbor-vault','json']}]}); if (selected.canceled) return null;
      const status = await vault.status(); if (status.exists) { const answer = await dialog.showMessageBox(win,{type:'warning',message:'Replace this device’s vault?',detail:'Export a backup first if you need to keep its current contents. The imported vault must be unlocked with its original password.',buttons:['Cancel','Replace vault'],defaultId:0,cancelId:0}); if (answer.response !== 1) return null; }
      assertGeneration(generation); sshImportPreview=null; ++syncEpoch; syncer.configure({enabled:false}); await serialize(()=>saveDevice({...device,autoSync:false})); connections.closeAll(); const d = await serialize(() => { assertGeneration(generation); return vault.importFrom(selected.filePaths[0],args.password,true); }); syncer.configure({enabled:false,unlocked:true}); startBackupCleanup(); touch(); return d;
    }
    case 'vault:chooseSync': {
      await vault.read();const selected=await dialog.showOpenDialog(win,{title:'Choose your encrypted vault sync folder',properties:['openDirectory','createDirectory']});if(selected.canceled)return null;assertGeneration(generation);
      await serialize(async()=>{assertGeneration(generation);await saveDevice({...device,syncFolder:selected.filePaths[0],autoSync:false});++syncEpoch;syncer.configure({enabled:false})});return vault.read();
    }
    case 'vault:autoSync': {
      await vault.read();if(typeof args.enabled!=='boolean')throw new Error('Invalid automatic sync setting');if(args.enabled&&!device.syncFolder)throw new Error('Choose a sync folder first');
      await serialize(async()=>{assertGeneration(generation);await saveDevice({...device,autoSync:args.enabled});assertGeneration(generation);++syncEpoch;syncer.configure({enabled:args.enabled,unlocked:true})});return vault.read();
    }
    case 'vault:syncStatus': return syncer.state;
    case 'vault:sync': await vault.read(); return syncer.run(true);
    case 'vault:compareSync': await vault.read();return serialize(()=>{assertGeneration(generation);return vault.compareSync(device.syncFolder)});
    case 'vault:resolveSync': { mcp?.pause();
      await vault.read();if(!device.syncFolder)throw new Error('Choose a sync folder first');
      const result=await serialize(()=>{assertGeneration(generation);return vault.resolveSync(device.syncFolder,args.choice)});
      assertGeneration(generation);syncer.resume(result);const data=viewData(await vault.read());assertGeneration(generation);send('vault:changed',data);return {result,data};
    }
    case 'clipboard:write': if(typeof args.text!=='string'||!args.text.length||args.text.length>100000)throw new Error('Select between 1 and 100,000 characters to copy.'); await clipboard.writeText(args.text); return true;
    case 'key:generate': { await vault.read(); const keys=require('./keys.cjs').generateKeyPair('ed25519',{comment:'Harbor'}); return {privateKey:keys.private,publicKey:keys.public}; }
    case 'key:import': { await vault.read(); const selected = await dialog.showOpenDialog(win,{title:'Import an SSH private key',properties:['openFile']}); if (selected.canceled) return null; const stat = await fs.stat(selected.filePaths[0]); if (stat.size > 100000) throw new Error('Key file is too large'); return fs.readFile(selected.filePaths[0],'utf8'); }
    case 'terminal:connect': await vault.read(); assertGeneration(generation); return terminals.open(args.hostId ? {hostId:args.hostId,sessionRef:args.sessionRef} : {host:args.host,sessionRef:args.sessionRef});
    case 'terminal:terminate': await vault.read(); assertGeneration(generation); return terminals.terminate(args.id);
    case 'terminal:local': await vault.read(); assertGeneration(generation); return terminals.open(null,true);
    case 'terminal:reconnect': await vault.read(); assertGeneration(generation); return terminals.reconnect(args.id);
    case 'terminal:autoReconnect': await vault.read(); terminals.setAutoReconnect(args.id,args.enabled); return true;
    case 'terminal:cancelReconnect': terminals.cancel(args.id); return true;
    case 'terminal:write': {
      const connection = connections._session(args.id);
      await vault.read();
      if (connections._session(args.id) !== connection) throw new Error('Connection changed; input was discarded');
      connections.write(args.id,args.data); return true;
    }
    case 'terminal:resize': await vault.read(); connections.resize(args.id,args.cols,args.rows); return true;
    case 'terminal:close': terminals.close(args.id); return true;
    case 'files:local': await vault.read(); return files.listLocal(args.path);
    case 'files:choose': {await vault.read(); const result=await dialog.showOpenDialog(win,{title:'Choose local folder',properties:['openDirectory']});assertGeneration(generation);return result.canceled?null:files.listLocal(result.filePaths[0]);}
    case 'files:rename': await vault.read(); return files.rename(args.id,args.path,args.name);
    case 'files:chmod': await vault.read(); return files.chmod(args.id,args.path,args.mode);
    case 'files:readText': await vault.read(); return files.readText(args.id,args.path);
    case 'files:saveText': await vault.read(); return files.saveText(args.id,args.path,args.text,args.hash);
    case 'transfer:list': await vault.read(); return files.list();
    case 'transfer:start': await vault.read(); return files.start(args);
    case 'transfer:cancel': await vault.read(); files.cancel(args.id); return true;
    case 'sftp:list': await vault.read(); return connections.listFiles(args.id,args.path || '.');
    case 'sftp:upload': { await vault.read(); const s = await dialog.showOpenDialog(win,{title:'Upload file',properties:['openFile']}); if (s.canceled) return null; const remote = path.posix.join(args.path,path.basename(s.filePaths[0])); await connections.upload(args.id,s.filePaths[0],remote); return true; }
    case 'sftp:download': { await vault.read(); const s = await dialog.showSaveDialog(win,{title:'Download file',defaultPath:args.name}); if (s.canceled) return null; await connections.download(args.id,args.path,s.filePath); return true; }
    case 'sftp:mkdir': await vault.read(); required(args.name,'Folder name',200); if (/[\/\\]/.test(args.name) || ['.','..'].includes(args.name)) throw new Error('Invalid folder name'); await connections.mkdir(args.id,path.posix.join(args.path,args.name)); return true;
    case 'sftp:remove': await vault.read(); await connections.removeFile(args.id,args.path); return true;
    case 'forward:start': { const d = await vault.read(); const f = d.forwardings.find(x => x.id === args.id); if (!f) throw new Error('Forwarding not found'); let host = d.hosts.find(x => x.id === f.hostId); if (!host) throw new Error('SSH host not found'); host=resolveHost(d,host); assertGeneration(generation); return connections.startForward(host,credential(d,host),f,route(d,host)); }
    case 'forward:stop': connections.stopForward(args.id); return true;
    case 'history:clear': return edit(d => { d.history = []; });
    case 'window:minimize': win.minimize(); return true;
    case 'window:maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); return true;
    case 'window:close': win.close(); return true;
    default: throw new Error('Unsupported action');
  }
}
app.whenReady().then(async () => {
  try{releaseRuntime=require('./runtime-lock.cjs').acquireRuntime(app.getPath('userData'));}catch(error){dialog.showErrorBox('Harbor is already running',error.message);app.quit();return;}
  try { const saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'device.json'),'utf8')); if(typeof saved.syncFolder==='string' && path.isAbsolute(saved.syncFolder))device.syncFolder=saved.syncFolder; device.autoSync=saved.autoSync===true; } catch {}
  updates=new UpdateChecker({dir:app.getPath('userData'),version:app.getVersion(),platform:process.platform,arch:process.arch,emit:state=>send('updates:changed',state)});
  await updates.load();
  vault = new Vault(path.join(app.getPath('userData'),'vault.hbr'));
  if(!(await vault.status()).exists)device.autoSync=false;
  syncer=new FolderSync({sync:synchronize,emit:state=>send('vault:syncStatus',state)});
  syncer.configure({enabled:device.autoSync===true,unlocked:false});
  authPrompts = new AuthPrompts(send);
  connections = new ConnectionManager({emit:send,requestAuth:(details,options)=>authPrompts.request(details,options),verifyHost:async info => {
    const d = await vault.read(); const id = `${info.hostname}:${info.port}`; const prior = d.knownHosts[id];
    if (prior?.fingerprint === info.fingerprint || prior === info.fingerprint) return true;
    if (prior) { await dialog.showMessageBox(win,{type:'error',message:'Server identity has changed',detail:`${id}\nThe SSH host key differs from the trusted key. Connection blocked. Verify the server independently before removing the old key.`,buttons:['Close']}); return false; }
    const result = await dialog.showMessageBox(win,{type:'question',message:'Trust this SSH server?',detail:`${id}\n${info.algorithm || 'SSH'}\n${info.fingerprint}\n\nCompare this fingerprint with your server administrator before connecting.`,buttons:['Cancel','Trust and connect'],defaultId:0,cancelId:0});
    if (result.response !== 1) return false; await edit(data => { const current=data.knownHosts[id]; if(current && (typeof current==='string'?current:current.fingerprint)!==info.fingerprint)throw new Error('Server identity changed during approval'); data.knownHosts[id] = {fingerprint:info.fingerprint,algorithm:info.algorithm}; }); return true;
  },recordHistory:async entry => { await edit(d => { d.history.unshift({...Object.fromEntries(Object.entries(entry).filter(([,v])=>v!==undefined)),id:randomUUID(),at:new Date().toISOString()}); d.history=d.history.slice(0,200); }); }});
  terminals = new TerminalSessions(connections, async reference => {
    const generation = lockGeneration;
    const d = await vault.read();
    let host = reference.hostId ? d.hosts.find(h => h.id === reference.hostId) : reference.host;
    if (!host) throw new Error('Host no longer exists. Restore it or open a different host.');
    host = resolveHost(d,host); validateEntity('hosts',host); assertGeneration(generation);
    return {host,credential:credential(d,host),route:route(d,host)};
  });
  files=new Files(connections,send);
  mcp=new McpAccess({dir:app.getPath('userData'),readVault:()=>vault.read(),onApproval:showHarbor,onChange:()=>{send('mcp:changed',{pending:mcp?.pending.size||0});updateTray()},bridgePath:app.isPackaged?path.join(process.resourcesPath,'harbor-mcp.cjs'):path.join(__dirname,'mcp/bridge.cjs')});
  mcp.ssh=new (require('./mcp/ssh.cjs').McpSsh)({
    resolve:async id=>{const d=await vault.read();const raw=d.hosts.find(h=>h.id===id);if(!raw)throw new Error('Host no longer exists.');const host=resolveHost(d,raw);validateEntity('hosts',host);return {host,credential:credential(d,host),route:route(d,host)}},
    verifyHost:info=>{showHarbor();return connections.verifyHost(info)},requestAuth:(details,options)=>{showHarbor();const clientId=mcp.sessions.get(details.connectionId)?.clientId,client=mcp.state.clients.find(c=>c.id===clientId);return authPrompts.request({...details,...(client?{mcpClient:{id:client.id,name:client.name}}:{})},options)}
  });
  mcp.ssh.onClosed=id=>{mcp.sessions.delete(id);mcp.changed()};
  await mcp.load();await mcp.loadAudit();
  win = new BrowserWindow({width:1360,height:900,minWidth:960,minHeight:650,title:'Harbor',icon:path.join(app.getAppPath(),'assets/harbor.png'),backgroundColor:'#101218',frame:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const devUrl = process.env.HARBOR_DEV_URL;
  if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Invalid development URL');
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-navigate',(e,url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
  ipcMain.handle('harbor',async (event,action,args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Unauthorized caller');
    try { const generation=lockGeneration; const data=await invoke(action,args,generation); if(!['vault:lock','window:close'].includes(action))assertGeneration(generation); return {ok:true,data:data?.version===1&&Array.isArray(data.hosts)?viewData(data):data}; } catch (error) { return {ok:false,error:error.message || 'Operation failed'}; }
  });
  if (devUrl) win.loadURL(devUrl); else win.loadFile(path.join(__dirname,'../dist/index.html'));
  updates.start();
  powerMonitor.on('lock-screen',lock); powerMonitor.on('suspend',lock);
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'},{role:'windowMenu'}]));

  }
  updateTray();
  win.on('close',event=>{if(!quitting&&mcp?.state.background&&tray&&!tray.isDestroyed()){event.preventDefault();win.hide();}else if(!quitting&&process.platform==='darwin'){event.preventDefault();lock();win.hide();}});
  win.on('closed',() => { lock(); win=null; });
});
function showHarbor(){if(win&&!win.isDestroyed()){win.show();if(win.isMinimized())win.restore();win.focus();}}
function updateTray(){
 if(!app.isReady()||!mcp)return;
 if(!mcp.state.background){if(tray){tray.destroy();tray=null;showHarbor();}return;}
 try{
  if(!tray){tray=new Tray(path.join(app.getAppPath(),'assets/harbor.png'));tray.on('click',showHarbor);}
  tray.setToolTip(`Harbor · MCP ${mcp.active?'active':'paused'} · ${mcp.pending.size} pending`);
  tray.setContextMenu(Menu.buildFromTemplate([{label:mcp.pending.size?`Review ${mcp.pending.size} MCP request(s)`:'Open Harbor',click:showHarbor},{label:'Lock vault and pause MCP',click:lock},{label:'Quit Harbor',click:()=>app.quit()}]));
 }catch{send('mcp:changed',{pending:mcp.pending.size});}
}
app.on('activate',()=>{if(win){win.show();if(win.isMinimized())win.restore();win.focus();}});
app.on('window-all-closed',() => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit',() => { releaseRuntime?.();tray?.destroy();tray=null; void mcp?.close(); clearInterval(retentionTimer); quitting = true; ++syncEpoch; syncer?.close(); clearTimeout(timer); authPrompts?.cancelAll(); files?.cancelAll(); connections?.closeAll(); vault?.lock(); });

app.on('before-quit',()=>updates?.stop());
