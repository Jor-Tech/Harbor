'use strict';
const { OpenSSHAgent, BaseAgent, utils } = require('ssh2');
const net = require('node:net');
const { createHash } = require('node:crypto');
const {agentEndpoint: agentSocket} = require('./platform.cjs');
function keyInfo(value) {
  const key = utils.parseKey(value);
  if (key instanceof Error) throw new Error('The SSH agent returned an unsupported key');
  return { key, fingerprint: 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, ''), type:key.type, comment:key.comment || '' };
}
class BoundedAgent extends OpenSSHAgent {
  constructor(socket, signal) { super(socket); this.signal = signal; }
  getStream(callback) {
    if(this.signal?.aborted) return callback(new Error('Authentication cancelled'));
    const socket = net.createConnection(this.socketPath);
    let delivered = false;
    const abort = () => socket.destroy(new Error('Authentication cancelled'));
    const cleanup = () => { clearTimeout(timer); this.signal?.removeEventListener('abort',abort); };
    const timer = setTimeout(() => socket.destroy(new Error('SSH agent approval timed out')),120000);
    this.signal?.addEventListener('abort',abort,{once:true});
    socket.once('connect',()=>{delivered=true;callback(null,socket)});
    socket.on('error',()=>{if(!delivered){delivered=true;callback(new Error('Cannot connect to the SSH agent. Check that it is enabled and the socket path is correct.'))}});
    socket.once('close',cleanup);
  }
}
class SelectedAgent extends BaseAgent {
  constructor(agent, info) {
    super(); this.agent=agent; this.info=info;
    this.authState={fingerprint:info.fingerprint,keyType:info.type,signingRequested:false,signatureReturned:false};
  }
  getIdentities(callback) { callback(null,[this.info.key]); }
  sign(key,data,options,callback) {
    if(keyInfo(key).fingerprint!==this.info.fingerprint)return callback(new Error('Unexpected signing key'));
    this.authState.signingRequested=true;
    this.agent.sign(key,data,options,(error,signature)=>{
      if(!error)this.authState.signatureReturned=true;
      callback(error,signature);
    });
  }
}
async function selectAgent(auth, requestAuth, details, signal) {
  const agent = new BoundedAgent(agentSocket(auth), signal);
  const keys = await new Promise((resolve,reject)=>agent.getIdentities((e,v)=>e?reject(e):resolve(v)));
  if (signal.aborted) throw new Error('Authentication cancelled');
  if(!keys.length)throw new Error('The SSH agent has no available keys. Enable the agent and make an SSH key available in your password manager.');
  const identities=keys.map(keyInfo);
  let selected;
  if(auth.agentFingerprint) selected=identities.find(k=>k.fingerprint===auth.agentFingerprint.trim());
  else if(identities.length===1)selected=identities[0];
  else {
    const [fingerprint]=await requestAuth({...details,kind:'agent-key',name:'Choose an SSH agent key',instructions:'Select the key for this host. Only its public identity is shown; signing stays in the SSH agent.',prompts:[{prompt:'SSH key',echo:true,options:identities.map(k=>({value:k.fingerprint,label:`${k.comment || k.type} · ${k.fingerprint}`}))}]},{signal});
    selected=identities.find(k=>k.fingerprint===fingerprint);
  }
  if(!selected)throw new Error('The selected SSH key is not available from this agent');
  return new SelectedAgent(agent,selected);
}
module.exports={agentSocket,keyInfo,selectAgent};
