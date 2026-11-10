'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID,randomBytes,createHash,timingSafeEqual}=require('node:crypto');
const {LocalMcpServer}=require('./local-server.cjs');
const {ActionError,publicError,messages}=require('./errors.cjs');
const {rules,matches,matchesRule,savedApprovals}=require('./rules.cjs');
const {TOOLS,toolsFor}=require('./tools.cjs');
const {LIMITS,policy,text,allows,object}=require('./policy.cjs');
const hash=token=>createHash('sha256').update(token).digest('hex');
class McpAccess {
 constructor({dir,readVault,bridgePath,onChange=()=>{},onApproval=()=>{}}){
  Object.assign(this,{dir,readVault,bridgePath,onChange,onApproval});this.state={version:2,enabled:false,background:false,clients:[]};this.active=false;this.epoch=0;this.error='';this.queue=Promise.resolve();this.sessions=new Map();this.pending=new Map();this.sessionApprovals=new Map();this.auditRecords=[];this.auditWrite=Promise.resolve();this.rate=new Map();
  this.server=new LocalMcpServer({dir,authenticate:auth=>this.authenticate(auth),tools:peer=>this.tools(peer),call:(...args)=>this.call(...args),disconnected:peer=>{this.disconnect?.(peer);this.changed()}});
 }
 async load(){
  try{const raw=JSON.parse(await fs.readFile(path.join(this.dir,'mcp-access.json'),'utf8'));
   if(![1,2].includes(raw.version)||typeof raw.enabled!=='boolean'||!Array.isArray(raw.clients)||raw.clients.length>LIMITS.clients)throw new Error('Invalid state');
   const ids=new Set();for(const c of raw.clients){if(!/^[a-f0-9-]{36}$/.test(c.id)||ids.has(c.id)||!/^[a-f0-9]{64}$/.test(c.tokenHash))throw new Error('Invalid client');ids.add(c.id);text(c.name,80);policy(c);rules(c,c.automations||[],{headless:true});savedApprovals(c,c.approvals||[]);}
   this.state={version:2,enabled:raw.enabled,background:raw.background===true,clients:raw.clients.map(c=>({...c,...policy(c)}))};
  }catch(error){if(error.code!=='ENOENT')this.error='MCP configuration could not be read. Restore or remove mcp-access.json while Harbor is closed.';}
 }
 record(clientId,tool,status,hostId,approval,errorCode){
  const row={at:new Date().toISOString(),clientId,tool,status,...(hostId?{hostId}:{}),...(approval?{approval}:{}),...(Object.hasOwn(messages,errorCode)?{errorCode}:{})};
  this.auditRecords=[...this.auditRecords,row].slice(-LIMITS.audit);this.saveAudit();this.changed();
 }
 saveAudit(){
  this.auditDirty=true;
  if(!this.auditSaving){this.auditSaving=true;this.auditWrite=(async()=>{while(this.auditDirty){this.auditDirty=false;const records=JSON.stringify(this.auditRecords),file=path.join(this.dir,'mcp-audit.json'),temp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,records,{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true})}}})().catch(()=>{this.auditError='Activity log could not be saved.';this.pause();}).finally(()=>{this.auditSaving=false});}return this.auditWrite;
 }

 async clearAudit(clientId,confirmed){return this.manage(async()=>{
  await this.unlocked();if(this.headless)throw new Error('Clear activity in the Harbor window.');
  if(confirmed!==true)throw new Error('Confirm clearing activity.');
  if(clientId!==null&&(typeof clientId!=='string'||!this.state.clients.some(c=>c.id===clientId)&&!this.auditRecords.some(r=>r.clientId===clientId)))throw new Error('Unknown client.');
  this.auditRecords=clientId===null?[]:this.auditRecords.filter(r=>r.clientId!==clientId);this.auditError='';
  await this.saveAudit();if(this.auditError)throw new Error(this.auditError);this.changed();return this.snapshot();
 });}
 async loadAudit(){try{const stat=await fs.stat(path.join(this.dir,'mcp-audit.json'));if(stat.size>1000000)throw new Error('Too large');const raw=JSON.parse(await fs.readFile(path.join(this.dir,'mcp-audit.json'),'utf8'));if(!Array.isArray(raw))throw new Error('Invalid log');this.auditRecords=raw.slice(-LIMITS.audit).filter(r=>r&&typeof r.at==='string'&&typeof r.clientId==='string'&&typeof r.tool==='string'&&['requested','approved','denied','completed','failed','paused','revoked','disconnected'].includes(r.status)).map(r=>({at:r.at.slice(0,40),clientId:r.clientId.slice(0,128),tool:r.tool.slice(0,80),status:r.status,...(typeof r.hostId==='string'?{hostId:r.hostId.slice(0,128)}:{}),...(['once','session','saved','headless'].includes(r.approval)?{approval:r.approval}:{}),...(Object.hasOwn(messages,r.errorCode)?{errorCode:r.errorCode}:{})}));}catch(error){if(error.code!=='ENOENT')this.auditError='Previous activity log could not be read.';}}
 async persist(next){
  if(this.error)throw new Error(this.error);
  await fs.mkdir(this.dir,{recursive:true,mode:0o700});const file=path.join(this.dir,'mcp-access.json'),temp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true})}
  // Do not expose a setting during async cleanup, before changed() can apply
  // its desktop effects (notably creating the tray before background close).
  this.state=next;
 }
 manage(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 changed(){this.onChange();}
 async unlocked(){if(this.closed)throw new Error('Harbor is stopping.');await this.readVault();}
 authenticate(auth){
  if(this.closed||!this.active||!this.state.enabled||this.error||!auth||typeof auth.token!=='string'||!/^[a-f0-9]{64}$/.test(auth.token))throw new Error('MCP access is paused.');
  const client=this.state.clients.find(c=>c.id===auth.clientId);if(!client||!timingSafeEqual(Buffer.from(hash(auth.token),'hex'),Buffer.from(client.tokenHash,'hex')))throw new Error('Unpaired client.');
  return client;
 }
 require(peer){if(this.closed||!this.active||!this.state.enabled||peer.socket.destroyed)throw new Error('Access paused.');const c=this.state.clients.find(c=>c.id===peer.client.id);if(!c)throw new Error('Client revoked.');return c;}
 tools(peer){return toolsFor(this.require(peer));}
 async call(peer,name,args,signal){
  const client=this.require(peer),epoch=this.epoch;const now=Date.now(),rate=this.rate.get(client.id)||{start:now,count:0};if(now-rate.start>60000){rate.start=now;rate.count=0;}if(++rate.count>60)throw new Error('MCP rate limit reached.');this.rate.set(client.id,rate);await this.unlocked();if(epoch!==this.epoch)throw new Error('Access changed.');this.require(peer);
  if(!['harbor_list_hosts','harbor_list_sessions'].includes(name))return this.action(peer,name,args,signal);
  object(args,[]);
  if(name==='harbor_list_hosts'&&allows(client,'hosts')){const d=await this.readVault();this.require(peer);if(epoch!==this.epoch)throw new Error('Access changed.');return {hosts:d.hosts.filter(h=>allows(client,'hosts',h.id)).map(h=>({id:h.id,label:String(h.label||'').slice(0,200),address:String(h.address||'').slice(0,253),port:Number.isInteger(Number(h.port))?Number(h.port):22})),untrustedContent:true};}
  if(name==='harbor_list_sessions'&&allows(client,'sessions'))return {sessions:[...this.sessions.values()].filter(s=>s.clientId===client.id&&allows(client,'sessions',s.hostId)).map(s=>({id:s.id,hostId:s.hostId,status:s.status}))};
  throw new Error('Tool not permitted.');
 }
 snapshot(){return {enabled:this.state.enabled,active:this.active,background:this.state.background,error:this.error,endpoint:this.server.address,
  clients:this.state.clients.map(({tokenHash,...c})=>({...c,config:{mcpServers:{harbor:{command:'node',args:[this.bridgePath,'--credential',this.credentialPath(c.id)]}}}})),
  connections:[...this.server.peers.values()].filter(p=>p.client).map(p=>({id:p.connectionId,clientId:p.client.id,name:this.state.clients.find(c=>c.id===p.client.id)?.name||p.client.name})),temporaryApprovals:[...this.sessionApprovals.values()],auditError:this.auditError||'',pending:[...this.pending.values()].map(p=>({id:p.id,client:this.state.clients.find(c=>c.id===p.peer.client.id)?.name||p.clientName,clientId:p.peer.client.id,tool:p.tool,args:p.args,target:p.target,expires:p.expires})),audit:this.auditRecords};}
 credentialPath(id){return path.join(this.dir,'mcp-clients',id+'.json');}
 async setEnabled(enabled){return this.manage(async()=>{await this.unlocked();if(typeof enabled!=='boolean')throw new Error('Invalid setting.');this.pause();const epoch=this.epoch;await this.persist({...this.state,enabled});if(enabled){await this.server.start();await this.unlocked();if(epoch!==this.epoch)throw new Error('Access changed while enabling MCP.');this.active=true;}else await this.server.stop();this.changed();return this.snapshot();});}
 async saveRules(id,input,confirmed){return this.manage(async()=>{
  await this.unlocked();if(this.headless)throw new Error('Manage headless permissions in the Harbor window.');
  const epoch=this.epoch,client=this.state.clients.find(c=>c.id===id);if(!client)throw new Error('Unknown client.');if(confirmed!==true)throw new Error('Confirm unattended action and output access.');
  const parsed=rules(client,input,{headless:true}),previous=rules(client,client.automations||[],{headless:true}),removing=parsed.length<previous.length&&parsed.every(rule=>previous.some(old=>JSON.stringify(old)===JSON.stringify(rule))),automations=[];
  for(const rule of parsed){
   // Revoking a rule must remain possible even when another stored destination is stale or unavailable.
   if(removing){automations.push(rule);continue;}
   const description=await this.ssh.describe(rule.hostId);await this.unlocked();if(epoch!==this.epoch)throw new Error('Access changed.');
   if(rule.binding&&rule.binding!==description.approvalDigest)throw new Error('SSH target changed. Remove the outdated rule and review the destination again.');
   if(!rule.binding&&(rule.scope||rule.tool==='harbor_write_file'))throw new Error('Review the SSH destination before allowing broad access or file writes.');
   automations.push({...rule,binding:description.approvalDigest,destination:this.destination(description.target)});
  }
  this.pause();await this.persist({...this.state,clients:this.state.clients.map(c=>c.id===id?{...c,automations}:c)});return this.snapshot();
 });}
 async previewApproval(id,hostId){
  await this.unlocked();const description=await this.ssh.describe(hostId);await this.unlocked();const client=this.state.clients.find(c=>c.id===id);if(!client?.hostIds.includes(hostId))throw new Error('Host not permitted.');return {binding:description.approvalDigest,target:description.target};
 }
 async addApproval(id,input,confirmed,binding){return this.manage(async()=>{
  await this.unlocked();const epoch=this.epoch,client=this.state.clients.find(c=>c.id===id);if(!client)throw new Error('Unknown client.');if(confirmed!==true)throw new Error('Confirm this action and sharing its results.');
  const rule=rules(client,[input],{allowAllCommands:true,allowFileWrites:true,allowFileScopes:true})[0],description=await this.ssh.describe(rule.hostId);await this.unlocked();if(epoch!==this.epoch)throw new Error('Access changed.');if(binding!==description.approvalDigest)throw new Error('SSH target changed. Review the destination again.');
  const entry=this.approvalEntry(client,rule,description),approvals=this.appendApproval(client.approvals||[],entry);savedApprovals(client,approvals);
  this.pause();await this.persist({...this.state,clients:this.state.clients.map(c=>c.id===id?{...c,approvals}:c)});this.record(id,rule.tool,'approved',rule.hostId,'saved');return this.snapshot();
 });}
 async addFullApproval(id,hostId,confirmed,binding){return this.manage(async()=>{
  await this.unlocked();if(this.headless)throw new Error('Manage automatic approvals in the Harbor window.');
  const epoch=this.epoch,client=this.state.clients.find(c=>c.id===id);if(!client)throw new Error('Unknown client.');
  if(confirmed!==true)throw new Error('Confirm full automatic approval and sharing all results.');
  const input=['harbor_connect','harbor_exec','harbor_list_files','harbor_read_file','harbor_write_file','harbor_disconnect'].map(tool=>({tool,hostId,...(tool==='harbor_exec'?{scope:'all-commands'}:['harbor_list_files','harbor_read_file','harbor_write_file'].includes(tool)?{scope:'all-paths'}:{})}));
  // Validate every action first. Full approval never widens ordinary host rights.
  const parsed=rules(client,input,{allowAllCommands:true,allowFileWrites:true,allowFileScopes:true});
  const description=await this.ssh.describe(hostId);await this.unlocked();if(epoch!==this.epoch)throw new Error('Access changed.');
  if(binding!==description.approvalDigest)throw new Error('SSH target changed. Review the destination again.');
  const approvals=[...(client.approvals||[]).filter(entry=>entry.rule.hostId!==hostId),...parsed.map(rule=>this.approvalEntry(client,rule,description))];
  savedApprovals(client,approvals);
  this.pause();await this.persist({...this.state,clients:this.state.clients.map(c=>c.id===id?{...c,approvals}:c)});
  for(const rule of parsed)this.record(id,rule.tool,'approved',hostId,'saved');return this.snapshot();
 });}
 async removeApproval(id,approvalId){return this.manage(async()=>{
  await this.unlocked();const client=this.state.clients.find(c=>c.id===id);if(!client)throw new Error('Unknown client.');
  const temporary=this.sessionApprovals.get(approvalId);if(!client.approvals?.some(r=>r.id===approvalId)&&temporary?.clientId!==id)throw new Error('Unknown approval.');
  this.pause();await this.persist({...this.state,clients:this.state.clients.map(c=>c.id===id?{...c,approvals:(c.approvals||[]).filter(r=>r.id!==approvalId)}:c)});this.record(id,'permission','revoked');return this.snapshot();
 });}
 async clearHostApprovals(id,hostId){return this.manage(async()=>{
  await this.unlocked();const client=this.state.clients.find(c=>c.id===id);if(!client)throw new Error('Unknown client.');
  if(typeof hostId!=='string'||!client.hostIds.includes(hostId))throw new Error('Host not permitted.');
  this.pause();await this.persist({...this.state,clients:this.state.clients.map(c=>c.id===id?{...c,approvals:(c.approvals||[]).filter(entry=>entry.rule.hostId!==hostId)}:c)});this.record(id,'permission','revoked',hostId);return this.snapshot();
 });}
 destination(target){return `${target.username||''}@${target.address}:${target.port||22}${target.via?.length?' via '+target.via.join(' → '):''}`;}
 approvalEntry(client,rule,description){
  const entry={id:randomUUID(),rule,binding:description.approvalDigest,destination:this.destination(description.target)};
  return savedApprovals(client,[entry])[0];
 }
 appendApproval(entries,entry){if(entries.some(r=>r.binding===entry.binding&&JSON.stringify(r.rule)===JSON.stringify(entry.rule)))return entries;if(entries.length>=20)throw new Error('At most 20 remembered approvals.');return [...entries,entry];}
 async setBackground(background){return this.manage(async()=>{await this.unlocked();if(typeof background!=='boolean')throw new Error('Invalid setting.');await this.persist({...this.state,background});this.changed();return this.snapshot();});}
 async resume(){return this.manage(async()=>{const epoch=this.epoch;await this.unlocked();if(!this.state.enabled||this.error)throw new Error('Enable MCP first.');await this.server.start();await this.unlocked();if(epoch!==this.epoch)throw new Error('Access changed during resume.');this.active=true;this.changed();return this.snapshot();});}
 // A vault lock can retain the authenticated MCP transport so stdio clients do
 // not have to restart their bridge. Every request still checks active access;
 // SSH sessions, approvals and in-flight results are invalidated in either case.
 pause({keepClients=false}={}){this.active=false;this.epoch++;if(!keepClients)this.server.closePeers();this.cancelAll?.();this.changed();}
 async create(args){return this.manage(async()=>{
  await this.unlocked();if(this.state.clients.length>=LIMITS.clients)throw new Error('Client limit reached.');const name=text(args.name?.trim(),80),id=randomUUID(),token=randomBytes(32).toString('hex');
  const serverIdentity=await this.server.identity();
  const client={id,name,tokenHash:hash(token),hostIds:[],rights:[]};const folder=path.dirname(this.credentialPath(id));await fs.mkdir(folder,{recursive:true,mode:0o700});
  try{await fs.writeFile(this.credentialPath(id),JSON.stringify({clientId:id,token,endpoint:this.server.address,serverCertificate:serverIdentity.cert}),{flag:'wx',mode:0o600});await this.persist({...this.state,clients:[...this.state.clients,client]});}
  catch(error){await fs.rm(this.credentialPath(id),{force:true});throw error;}this.changed();return this.snapshot();
 });}
 async rename(id,value){return this.manage(async()=>{
  await this.unlocked();if(!this.state.clients.some(client=>client.id===id))throw new Error('Unknown client.');const name=text(typeof value==='string'?value.trim():value,80);
  await this.persist({...this.state,clients:this.state.clients.map(client=>client.id===id?{...client,name}:client)});this.changed();return this.snapshot();
 });}
 async update(id,value){return this.manage(async()=>{await this.unlocked();if(!this.state.clients.some(c=>c.id===id))throw new Error('Unknown client.');const p=policy(value);const data=await this.readVault();if(p.hostIds.some(id=>!data.hosts.some(h=>h.id===id)))throw new Error('Host no longer exists.');this.pause();await this.persist({...this.state,clients:this.state.clients.map(c=>c.id===id?{...c,...p,automations:[],approvals:[]}:c)});return this.snapshot();});}
 async revoke(id){return this.manage(async()=>{await this.unlocked();if(!this.state.clients.some(c=>c.id===id))throw new Error('Unknown client.');this.pause();await this.persist({...this.state,clients:this.state.clients.filter(c=>c.id!==id)});await fs.rm(this.credentialPath(id),{force:true});this.record(id,'client','revoked');return this.snapshot();});}
 disconnectClient(id){this.server.closePeers(id);for(const [key,r] of this.sessionApprovals)if(r.clientId===id)this.sessionApprovals.delete(key);this.record(id,'client','disconnected');this.changed();return this.snapshot();}
 disconnect(peer){
  for(const [key,r] of this.sessionApprovals)if(r.connectionId===peer.connectionId&&r.clientId===peer.client?.id)this.sessionApprovals.delete(key);
  for(const p of [...this.pending.values()])if(p.connectionId===peer.connectionId)p.finish(new ActionError('REQUEST_CANCELLED'));
  for(const [id,s] of this.sessions)if(s.connectionId===peer.connectionId){this.ssh?.close(id);this.sessions.delete(id);}
 }
 cancelAll(){for(const p of [...this.pending.values()])p.finish(new ActionError('REQUEST_CANCELLED'));this.ssh?.closeAll();this.sessions.clear();this.sessionApprovals.clear();}
 approve(peer,tool,args,description,signal){
  const target=description.target,c=this.require(peer);if(signal?.aborted)throw new ActionError('REQUEST_CANCELLED');
  if(this.headless){if(!matches(c,tool,target.id,args,description.approvalDigest))throw new Error('Headless rule required.');this.record(c.id,tool,'approved',target.id,'headless');return Promise.resolve();}
  const match=r=>r.binding===description.approvalDigest&&matchesRule(r.rule,tool,target.id,args);
  if((c.approvals||[]).some(match)){this.record(c.id,tool,'approved',target.id,'saved');return Promise.resolve();}
  if([...this.sessionApprovals.values()].some(r=>r.clientId===c.id&&r.connectionId===peer.connectionId&&match(r))){this.record(c.id,tool,'approved',target.id,'session');return Promise.resolve();}
  if(this.pending.size>=LIMITS.pending)throw new Error('Too many pending requests.');
  return new Promise((resolve,reject)=>{
   const id=randomUUID();let timer;
   const abort=()=>finish(new ActionError('REQUEST_CANCELLED'));
   const finish=(error,approval='once')=>{if(!this.pending.delete(id))return;this.record(peer.client.id,tool,error?'denied':'approved',target.id,error?undefined:approval,error?publicError(error).code:undefined);clearTimeout(timer);signal?.removeEventListener('abort',abort);this.changed();error?reject(error):resolve();};
   this.record(peer.client.id,tool,'requested',target.id);
   this.pending.set(id,{id,peer,connectionId:peer.connectionId,clientName:peer.client.name,tool,args,target,description,expires:Date.now()+LIMITS.approvalMs,finish});
   timer=setTimeout(()=>finish(new ActionError('APPROVAL_EXPIRED')),LIMITS.approvalMs);signal?.addEventListener('abort',abort,{once:true});this.changed();this.onApproval();
  });
 }
 answer(id,approved,share,remember='once',writePermission){
  const p=this.pending.get(id);if(!p||p.expires<Date.now())throw new ActionError('APPROVAL_EXPIRED');const client=this.require(p.peer);
  if(approved!==true){p.finish(new ActionError('REQUEST_DENIED'));return this.snapshot();}if(share!==true)throw new Error('Acknowledge action and data sharing.');
  if(!['once','session','always'].includes(remember))throw new Error('Invalid approval duration.');
  if(remember==='once'){p.finish();return this.snapshot();}
  const write=p.tool==='harbor_write_file';
  if(write){
   object(writePermission,['confirm','scope']);
   if(writePermission.confirm!==true||!['exact','directory'].includes(writePermission.scope))throw new Error('Review and authorize the automatic write scope.');
  }else if(writePermission!==undefined)throw new Error('Unexpected write permission.');
  const rule=rules(client,[{tool:p.tool,hostId:p.target.id,...(write?{path:writePermission.scope==='directory'?path.posix.dirname(p.args.path):p.args.path,...(writePermission.scope==='directory'?{scope:'directory'}:{})}:p.tool==='harbor_exec'?{command:p.args.command}:['harbor_list_files','harbor_read_file'].includes(p.tool)?{path:p.args.path}:{})}],{allowFileWrites:write})[0];
  if(!matchesRule(rule,p.tool,p.target.id,p.args))throw new Error('Permission does not cover this request.');
  const entry=this.approvalEntry(client,rule,p.description);
  if(remember==='session'){
   const existing=[...this.sessionApprovals.values()].filter(r=>r.clientId===client.id),duplicate=existing.some(r=>r.connectionId===p.connectionId&&r.binding===entry.binding&&JSON.stringify(r.rule)===JSON.stringify(entry.rule));
   if(!duplicate){if(existing.length>=20)throw new Error('At most 20 temporary approvals per client.');this.sessionApprovals.set(entry.id,{...entry,clientId:client.id,connectionId:p.connectionId});}p.finish(null,'session');return this.snapshot();
  }
  return this.manage(async()=>{
   await this.unlocked();if(this.pending.get(id)!==p||p.expires<Date.now())throw new ActionError('APPROVAL_EXPIRED');const current=this.require(p.peer),epoch=this.epoch;
   const approvals=this.appendApproval(current.approvals||[],entry);savedApprovals(current,approvals);
   await this.persist({...this.state,clients:this.state.clients.map(c=>c.id===current.id?{...c,approvals}:c)});
   if(epoch!==this.epoch||this.pending.get(id)!==p)throw new Error('Access changed while saving approval.');this.require(p.peer);p.finish(null,'saved');return this.snapshot();
  });
 }
 async action(peer,name,input,signal){
  const cancel=new AbortController();signal=signal?AbortSignal.any([signal,cancel.signal]):cancel.signal;
  const client=this.require(peer),epoch=this.epoch,tool=TOOLS.find(t=>t.name===name);if(!tool||!this.ssh)throw new Error('Tool unavailable.');
  const args=JSON.parse(JSON.stringify(input));object(args,Object.keys(tool.inputSchema.properties));for(const key of tool.inputSchema.required)if(!(key in args))throw new Error('Missing argument.');
  for(const key of Object.keys(args)){if(key==='content'){if(typeof args.content!=='string'||Buffer.byteLength(args.content)>LIMITS.output)throw new Error('Content too large.');}else text(args[key],key==='command'?16384:4096);}
  let session,hostId;
  if(name==='harbor_connect')hostId=args.hostId;
  else{session=this.sessions.get(args.sessionId);if(!session||session.clientId!==client.id||session.connectionId!==peer.connectionId)throw new Error('Not your session.');hostId=session.hostId;}
  if(!allows(client,tool.right,hostId))throw new Error('Host or action not permitted.');
  if(args.path&&(!path.posix.isAbsolute(args.path)||path.posix.normalize(args.path)!==args.path||args.path.length>2048))throw new Error('Use a normalized absolute remote path.');
  const check=()=>{if(signal?.aborted||epoch!==this.epoch)throw new ActionError('REQUEST_CANCELLED');this.require(peer);};
  const description=await this.ssh.describe(hostId);check();
  await this.approve(peer,name,args,description,signal);check();
  if((await this.ssh.describe(hostId)).digest!==description.digest)throw new Error('Host changed since approval.');check();
  const id=name==='harbor_connect'?randomUUID():args.sessionId;
  // Key-manager approval and MFA need the same authentication window as GUI SSH.
  const operationTimer=setTimeout(()=>cancel.abort(),name==='harbor_connect'?LIMITS.connectionMs:LIMITS.executionMs);
  const abort=()=>this.ssh.close(id);signal?.addEventListener('abort',abort,{once:true});
  let failure;
  try{
   if(name==='harbor_connect'){
    if(this.sessions.size>=LIMITS.connections)throw new Error('Connection limit reached.');
    this.sessions.set(id,{id,hostId,clientId:client.id,connectionId:peer.connectionId,status:'connecting'});
    try{await this.ssh.connect(hostId,description.digest,check,id);check();this.sessions.get(id).status='connected';return {sessionId:id};}catch(e){this.ssh.close(id);this.sessions.delete(id);throw e;}
   }
   if(name==='harbor_disconnect'){this.ssh.close(id);this.sessions.delete(id);return {closed:true};}
   if(name==='harbor_exec'){const result=await this.ssh.exec(id,args.command,check);check();return result;}
   if(name==='harbor_list_files')return await this.ssh.list(id,args.path,check);
   if(name==='harbor_read_file')return await this.ssh.read(id,args.path,check);
   if(name==='harbor_write_file'){const result=await this.ssh.write(id,args.path,args.content,check);check();return result;}
   throw new Error('Unknown tool.');
  }catch(error){failure=signal?.aborted||epoch!==this.epoch?new ActionError('REQUEST_CANCELLED'):error instanceof ActionError?error:new ActionError('APPROVED_ACTION_FAILED');throw failure;}finally{clearTimeout(operationTimer);signal?.removeEventListener('abort',abort);this.record(client.id,name,failure||signal?.aborted||epoch!==this.epoch?'failed':'completed',hostId,undefined,failure?.code);this.changed();}
 }
 async close(){this.closed=true;this.pause();await this.queue;await this.server.stop();await this.auditWrite;}
}
module.exports={McpAccess};
