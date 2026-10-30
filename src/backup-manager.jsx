import {BackupRetention} from './backup-retention.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {X,Shield,Trash2,RefreshCw,FolderArchive} from 'lucide-react';
const reasons={save:'Before an edit',password:'Before a password change',upgrade:'Before a vault update',import:'Before an import',sync:'Before a sync download',resolve:'Before resolving a conflict',manual:'Manual backup',recovery:'Before recovery',history:'Sync revision',conflict:'Conflict copy'};
const sources={local:'Local recovery',legacy:'Older import backup',history:'Shared history',conflict:'Shared conflict'};
const sizeLabel=n=>n<1024?`${n} B`:n<1024*1024?`${(n/1024).toFixed(1)} KiB`:`${(n/1024/1024).toFixed(1)} MiB`;

export function BackupManager({call,close,onChanged,syncFolder}) {
 const [scope,setScope]=useState('local'),[list,setList]=useState(null),[selected,setSelected]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [inspect,setInspect]=useState(null),[password,setPassword]=useState(''),[preview,setPreview]=useState(null),[verified,setVerified]=useState({}),[confirm,setConfirm]=useState(false),[acknowledged,setAcknowledged]=useState(false);
 const generation=useRef(0),closeRef=useRef(null),detailRef=useRef(null);
 function clearDetail(){setInspect(null);setPassword('');setPreview(null);setConfirm(false);setAcknowledged(false)}
 async function refresh(){
  const current=++generation.current;setBusy(true);setError('');setList(null);setSelected([]);setVerified({});clearDetail();
  try{const result=await call('vault:managedBackups',{scope});if(current===generation.current)setList(result)}catch(e){if(current===generation.current)setError(e.message)}finally{if(current===generation.current)setBusy(false)}
 }
 useEffect(()=>{refresh();return()=>{generation.current++}},[scope,syncFolder]);
 useEffect(()=>{closeRef.current?.focus()},[]);
 useEffect(()=>{detailRef.current?.scrollIntoView({block:'nearest'})},[inspect,confirm,preview]);
 useEffect(()=>{const listener=e=>{if(e.key==='Escape'&&!busy){e.stopPropagation();if(inspect||confirm)clearDetail();else close()}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener)},[busy,inspect,confirm,close]);
 const rows=list?.rows||[],chosen=rows.filter(row=>selected.includes(row.id));
 const toggle=id=>{clearDetail();setMessage('');setSelected(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id])};
 async function verify(e){
  e.preventDefault();setBusy(true);setError('');setPreview(null);const current=generation.current;
  try{const result=await call('vault:previewManagedBackup',{scope,token:list.token,id:inspect.id,password});if(current===generation.current){setPreview(result);setVerified(v=>({...v,[inspect.id]:result.protection}));}}
  catch(e){if(current===generation.current){setVerified(v=>{const next={...v};delete next[inspect.id];return next});setError(e.message)}}finally{if(current===generation.current){setPassword('');setBusy(false)}}
 }
 async function keep(row){
  setBusy(true);setError('');
  try{await call('vault:keepBackup',{token:list.token,id:row.id,keep:!row.kept});onChanged();await refresh();setMessage(row.kept?'Keep mark removed. This copy can be cleaned up under your retention settings.':'Marked Keep. This copy is excluded from automatic cleanup and must be unmarked before manual deletion.')}catch(e){setError(e.message)}finally{setBusy(false)}
 }
 async function remove(){
  setBusy(true);setError('');const current=generation.current;
  try{
   const result=await call('vault:deleteBackups',{scope,token:list.token,ids:selected,confirm:acknowledged});
   if(current!==generation.current)return;
   const report=`Deleted ${result.deleted.length} ${scope==='shared'?'shared copies':'local backups'}.`;
   onChanged();await refresh();setMessage(report);if(result.error)setError(`${result.error} ${result.remaining.length} selected copies were not deleted.`);
  }catch(e){if(current===generation.current){setConfirm(false);setAcknowledged(false);setError(e.message)}}finally{if(current===generation.current)setBusy(false)}
 }
 return <div className="auth-overlay"><section className="backup-manager" role="dialog" aria-modal="true" aria-labelledby="backup-manager-title" onKeyDown={e=>{if(e.key!=='Tab')return;const nodes=[...e.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}}>
  <header><FolderArchive size={23}/><div><h2 id="backup-manager-title">Manage backups</h2><p>Know where your recovery copies live.</p></div><button ref={closeRef} aria-label="Close backup manager" disabled={busy} onClick={close}><X size={20}/></button></header>
  <div className="backup-scope" role="tablist" aria-label="Backup location">
   <button role="tab" aria-selected={scope==='local'} disabled={busy} onClick={()=>{setScope('local');setMessage('')}}>Local backups</button>
   <button role="tab" aria-selected={scope==='shared'} disabled={busy} onClick={()=>{setScope('shared');setMessage('')}}>Shared sync history</button>
  </div>
  <div className="backup-manager-content">
   <p className="backup-explanation">{scope==='local'?'Recovery copies on this device, including backups made by older imports. Cleaning your sync folder does not remove these files.':'History and conflict copies for this vault in your configured sync folder. Deleting them affects recovery on other devices too. The active shared vault is never listed for deletion.'}</p>
   <p className="backup-explanation">Verify a copy with its password to check its contents before relying on it. Exports elsewhere and your storage provider’s trash or version history are not managed here.</p>
   {scope==='local'&&<BackupRetention call={call} state={list?.retention} busy={busy} onChange={async()=>{onChanged();await refresh()}} onError={setError}/>}
   {list?.retention?.error&&<p role="alert" className="backup-error">{list.retention.error}</p>}
   {list?.locations.map(location=><div className="backup-location" key={location}>{location}</div>)}
   {error&&<p role="alert" className="backup-error">{error}</p>}
   {message&&<p role="status" className="backup-result">{message}</p>}
   {busy&&!list&&<p className="backup-explanation">Reading backup files…</p>}
   {list?.truncated&&<p className="backup-explanation">Showing the {list.limit} most recent copies. Refresh after cleanup to see more.</p>}
   {list&&!rows.length&&<div className="backup-empty"><Shield size={28}/><p>No {scope==='local'?'local backups':'shared history or conflict copies'} found.</p></div>}
   {!!rows.length&&<>
    <div className="backup-toolbar"><span>{rows.length} copies · {selected.length} selected</span><button className="button" disabled={busy||!selected.length} onClick={()=>{setSelected([]);clearDetail()}}>Clear selection</button></div>
    <div className="backup-list">{rows.map(row=><article className={'backup-row '+(selected.includes(row.id)?'selected':'')} key={row.id}>
     <input type="checkbox" aria-label={`Select ${row.name}`} checked={selected.includes(row.id)} disabled={busy||confirm||!row.canDelete} onChange={()=>toggle(row.id)}/>
     <div className="backup-row-main"><strong>{new Date(row.createdAt).toLocaleString()} <span>· {reasons[row.reason]}</span></strong><small>{sources[row.source]} · {sizeLabel(row.size)}{row.dateSource==='modified'?' · File modification date':''}</small><details><summary>File location</summary><code>{row.location}</code></details>{row.problem&&<small className="backup-error">{row.problem}</small>}{scope==='local'&&<button className={'button backup-keep '+(row.kept?'kept':'')} aria-label={`${row.kept?'Remove Keep from':'Keep'} ${row.name}`} aria-pressed={row.kept===true} disabled={busy||confirm||row.kept===null||(!row.canDelete&&!row.kept)} onClick={()=>keep(row)}>{row.kept?'Kept · Remove Keep':'Keep this copy'}</button>}</div>
     <div className="backup-row-protection"><small>{verified[row.id]?'Verified with password':'Not yet verified'}</small><button className="button" disabled={busy||confirm||!row.canPreview} aria-label={`Preview ${row.name}`} onClick={()=>{clearDetail();setError('');setInspect(row)}}>Preview</button></div>
    </article>)}</div>
   </>}
   {inspect&&<form ref={detailRef} className="backup-detail" onSubmit={verify}>
    <h3>Verify backup contents</h3><p>{inspect.name}</p><label className="field"><span>Backup password</span><input aria-label="Backup password" type="password" required autoFocus maxLength={1024} autoComplete="off" disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></label>
    <div className="backup-detail-actions"><button className="button" type="button" disabled={busy} onClick={clearDetail}>Close preview</button><button className="button primary" disabled={busy||!password}>Verify backup</button></div>
    {preview&&<div className="backup-verified"><h3>Verified backup contents</h3><p>Revision {preview.revision}</p><dl>{Object.entries(preview.counts).map(([name,count])=><React.Fragment key={name}><dt>{name}</dt><dd>{count}</dd></React.Fragment>)}<dt>Trusted server identities</dt><dd>{preview.knownHosts}</dd></dl><p>{scope==='local'?'To restore this copy, close this manager and choose Recover backup.':'To restore this copy, close this manager and use Import encrypted vault with the file shown above.'} Previewing does not change your current vault.</p></div>}
   </form>}
   {confirm&&<div ref={detailRef} className="backup-detail backup-delete-confirm" role="region" aria-label="Confirm backup deletion"><h3>Delete {chosen.length} {scope==='shared'?'shared copies':'local backups'}?</h3><p>{sizeLabel(chosen.reduce((n,row)=>n+row.size,0))} in {scope==='shared'?'the shared sync folder':'this device’s data folder'}. This cannot be undone in Harbor.{scope==='shared'?' Other devices will also lose access to these shared recovery copies. A sync provider or another device may retain or recreate copies.':''}</p><p>Make and verify a fresh backup or export before removing copies you may still need. Provider trash and version history may retain deleted files.</p><ul>{chosen.map(row=><li key={row.id}>{row.location}</li>)}</ul><label className="protection-confirm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e=>setAcknowledged(e.target.checked)}/>I understand these selected copies will be deleted.</label><div className="backup-detail-actions"><button className="button" disabled={busy} onClick={()=>{setConfirm(false);setAcknowledged(false)}}>Cancel deletion</button><button className="button backup-danger" disabled={busy||!acknowledged} onClick={remove}>Delete {chosen.length} copies</button></div></div>}
  </div>
  <footer><button className="button" disabled={busy} onClick={()=>{setMessage('');refresh()}}><RefreshCw size={15}/> Refresh list</button><button className="button backup-danger" disabled={busy||!selected.length||confirm} onClick={()=>{clearDetail();setError('');setConfirm(true)}}><Trash2 size={15}/> Delete selected ({selected.length})</button><button className="button" disabled={busy} onClick={close}>Done</button></footer>
 </section></div>
}
