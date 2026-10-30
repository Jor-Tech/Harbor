import React, {useState} from 'react';
import {Network, Pencil, Play, StopCircle} from 'lucide-react';

export function forwardingFields(rule) {
 return {...rule,type:rule.type??'local',listenPort:rule.listenPort??rule.localPort??8080,destinationHost:rule.destinationHost??rule.remoteHost??'127.0.0.1',destinationPort:rule.destinationPort??rule.remotePort??80};
}
const labels={local:'Local tunnel',remote:'Remote tunnel',dynamic:'SOCKS5 proxy'};
function Field({label,hint,children}){return <label className="field"><span>{label}</span>{React.cloneElement(children,{'aria-label':label})}{hint&&<small>{hint}</small>}</label>}
export function ForwardingFields({item,setItem,hosts}) {
 const f=forwardingFields(item),set=(key,value)=>setItem(s=>({...forwardingFields(s),[key]:value}));
 return <>
  <Field label="Forwarding type"><select value={f.type} onChange={e=>set('type',e.target.value)}>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></Field>
  <div className="info-box"><p>{f.type==='local'?'Listen on this device and reach a destination from the SSH server.':f.type==='remote'?'Listen on the SSH server and reach a destination from this device. The server must allow remote forwarding.':'Listen on this device as a SOCKS5 proxy. Supports TCP; configure applications to resolve DNS through the proxy.'} Listeners use 127.0.0.1. {f.type==='dynamic'?'Other applications on this device can use this proxy while it is running.':''}</p></div>
  <Field label="SSH host" hint="Uses this host’s configured jump hosts and authentication."><select required value={f.hostId||''} onChange={e=>set('hostId',e.target.value)}><option value="">Choose a host</option>{hosts.map(h=><option key={h.id} value={h.id}>{h.label}</option>)}</select></Field>
  <Field label={f.type==='remote'?'Listen port on SSH server':'Listen port on this device'} hint="Use 0 to let the operating system choose an available port."><input required type="number" min="0" max="65535" value={f.listenPort} onChange={e=>set('listenPort',e.target.value===''?'':Number(e.target.value))}/></Field>
  {f.type!=='dynamic'&&<><Field label="Destination hostname" hint={f.type==='remote'?'Reached from this device. 127.0.0.1 means this laptop.':'Reached from the SSH server. 127.0.0.1 means that server.'}><input required value={f.destinationHost} onChange={e=>set('destinationHost',e.target.value)}/></Field><Field label="Destination port"><input required type="number" min="1" max="65535" value={f.destinationPort} onChange={e=>set('destinationPort',e.target.value===''?'':Number(e.target.value))}/></Field></>}
 </>;
}
export function ForwardingCard({rule,host,running,onToggle,onEdit,notify}) {
 const [pending,setPending]=useState(false),f=forwardingFields(rule);
 const endpoint=`127.0.0.1:${running?.port??(f.listenPort||'auto')}`;
 return <article className="forward-card">
  <div className="entity-icon"><Network size={25}/></div>
  <div><h3>{f.label}</h3><p>{labels[f.type]} · {f.type==='remote'?'SSH server':'This device'} {endpoint}</p>
   <small>{f.type==='dynamic'?'TCP destinations via ':`→ ${f.destinationHost}:${f.destinationPort} · via `}{host?.label||'Missing host'}{host?.jumpHostId?' (through jump hosts)':''}</small>
   <p role="status">{pending?'Connecting / stopping…':running?'Running':'Stopped'}</p>
  </div>
  <button className="button" disabled={pending||!!running} onClick={onEdit}><Pencil size={16}/> Edit</button>
  <button className={'button '+(running?'':'primary')} disabled={pending||(!host&&!running)} onClick={async()=>{setPending(true);try{await onToggle()}catch(error){notify(error.message,true)}finally{setPending(false)}}}>{running?<StopCircle size={16}/>:<Play size={16}/>} {pending?'Please wait…':running?'Stop':'Start'}</button>
 </article>;
}
