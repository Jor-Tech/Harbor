import React,{useState} from 'react';
import {X,Upload,AlertCircle} from 'lucide-react';
export function SSHImport({preview,data,call,onImported,close,notify}){
 const [selected,setSelected]=useState(preview.entries.filter(e=>!e.blocked.length&&!e.duplicates.length).map(e=>e.id)),[auth,setAuth]=useState({}),[ack,setAck]=useState(false),[copies,setCopies]=useState(false),[busy,setBusy]=useState(false);
 const chosen=preview.entries.filter(e=>selected.includes(e.id));
 const hasWarnings=preview.diagnostics.length>0||chosen.some(e=>e.warnings.length);
 const hasDuplicates=chosen.some(e=>e.duplicates.length);
 async function submit(e){e.preventDefault();setBusy(true);try{const d=await call('sshConfig:import',{previewId:preview.id,selections:chosen.map(e=>({id:e.id,auth:auth[e.id]||'config'})),acknowledgeWarnings:ack,allowDuplicates:copies});onImported(d);notify(`Imported ${chosen.length} SSH host${chosen.length===1?'':'s'}`);close()}catch(error){notify(error.message,true)}finally{setBusy(false)}}
 return <div className="overlay"><form className="ssh-import" role="dialog" aria-modal="true" aria-labelledby="ssh-import-title" onSubmit={submit}>
  <header><div><h2 id="ssh-import-title">Import SSH configuration</h2><p>{preview.source} · {selected.length} of {preview.entries.length} hosts selected</p></div><button type="button" aria-label="Close SSH import" disabled={busy} onClick={close}><X size={20}/></button></header>
  <div className="ssh-import-content"><p>Review the resolved address, credentials and warnings before importing. Existing hosts stay unchanged. Private key files are not opened or copied, and configuration commands are never run.</p>
   {preview.diagnostics.length>0&&<section className="import-warnings"><h3>File warnings</h3>{preview.diagnostics.map((w,i)=><p key={i}>Line {w.line} · <strong>{w.directive}</strong>: {w.message}</p>)}</section>}
   {!preview.entries.length&&<p>No named hosts found. Wildcard Host sections only supply defaults.</p>}
   {preview.entries.map(entry=><article className="import-host" key={entry.id}>
    <label className="import-host-title"><input type="checkbox" aria-label={`Import ${entry.alias}`} disabled={busy||!!entry.blocked.length} checked={selected.includes(entry.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,entry.id]:s.filter(id=>id!==entry.id))}/><strong>{entry.alias}</strong><small>Line {entry.line}</small></label>
    <p className="mono">{entry.host.username||'(local username)'}@{entry.host.address}:{entry.host.port}{entry.jump&&` via ${entry.jump}`}</p>
    {!!entry.duplicates.length&&<p className="import-warning">Already in Harbor: {entry.duplicates.map(d=>d.label).join(', ')}. Selecting this host adds another copy.</p>}
    {entry.blocked.map((reason,i)=><p className="import-warning" key={i}><AlertCircle size={14}/> {reason}</p>)}
    {!!entry.warnings.length&&<details><summary>{entry.warnings.length} option{entry.warnings.length===1?'':'s'} need review</summary>{entry.warnings.map((w,i)=><p key={i}>Line {w.line} · <strong>{w.directive}</strong>: {w.message}</p>)}</details>}
    {!entry.blocked.length&&<label className="field"><span>Authentication for {entry.alias}</span><select aria-label={`Authentication for ${entry.alias}`} value={auth[entry.id]||'config'} disabled={busy} onChange={e=>setAuth(a=>({...a,[entry.id]:e.target.value}))}><option value="config">{entry.host.agentProvider==='custom'?`Configured agent: ${entry.host.agentSocket}`:entry.host.agentProvider==='system'?'System SSH agent':'Configure credentials after import'}</option><option value="none">Password / configure later</option><option value="system">System SSH agent</option><option value="1password">1Password SSH agent</option>{data.keys.map(k=><option key={k.id} value={'key:'+k.id}>Vault key: {k.label}</option>)}</select></label>}
   </article>)}
  </div>
  <footer>{hasWarnings&&<label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>I reviewed the unsupported options and will configure anything missing before connecting.</label>}{hasDuplicates&&<label><input type="checkbox" checked={copies} onChange={e=>setCopies(e.target.checked)}/>Add selected duplicates as additional hosts.</label>}<div><button type="button" className="button" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy||!selected.length||hasWarnings&&!ack||hasDuplicates&&!copies}><Upload size={15}/>{busy?'Importing…':`Import ${selected.length} host${selected.length===1?'':'s'}`}</button></div></footer>
 </form></div>
}
