import React,{useEffect,useState} from 'react';
import {X,Shield,RefreshCw} from 'lucide-react';

const reasons={save:'Before an edit',password:'Before a password change',upgrade:'Before a vault update',import:'Before an import',sync:'Before a sync download',resolve:'Before resolving a conflict',manual:'Manual backup',recovery:'Before recovery'};

export function RecoveryDialog({call,close,onRestored}) {
 const [backups,setBackups]=useState([]),[id,setId]=useState(''),[password,setPassword]=useState(''),[preview,setPreview]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const clearPreview=()=>{setPreview(null);setConfirmed(false)};
 useEffect(()=>{let live=true;call('vault:backups').then(result=>{if(live){setBackups(result.backups);setId(result.backups[0]?.id||'')}}).catch(e=>{if(live)setError(e.message)}).finally(()=>{if(live)setBusy(false)});return()=>{live=false}},[]);
 async function refresh(){setBusy(true);setError('');clearPreview();setPassword('');try{const result=await call('vault:backups');setBackups(result.backups);setId(result.backups[0]?.id||'')}catch(e){setError(e.message)}finally{setBusy(false)}}
 async function inspect(e){e.preventDefault();setBusy(true);setError('');clearPreview();try{setPreview(await call('vault:previewRecovery',{id,password}))}catch(e){setError(e.message)}finally{setBusy(false)}}
 async function restore(){setBusy(true);setError('');try{const data=await call('vault:restoreBackup',{id,password,token:preview.token,confirm:confirmed});setPassword('');onRestored(data)}catch(e){setError(e.message);clearPreview()}finally{setBusy(false)}}
 return <div className="auth-overlay"><section className="recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
  <header><Shield size={24}/><h2 id="recovery-title">Recover from a local backup</h2><button disabled={busy} aria-label="Close recovery" onClick={close}><X size={18}/></button></header>
  <div className="recovery-content">
   <p>Preview a backup with the password used when it was created. This works even if your current vault cannot be unlocked. There is no password reset.</p>
   {!backups.length&&!busy&&<p>No local backups found. Close this window and use Import encrypted vault to restore an exported copy.</p>}
   {!!backups.length&&<form onSubmit={inspect}>
    <label className="field"><span>Local backup</span><select aria-label="Local backup" disabled={busy} value={id} onChange={e=>{setId(e.target.value);setPassword('');clearPreview();setError('')}}>{backups.map(b=><option key={b.id} value={b.id}>{new Date(b.createdAt).toLocaleString()} · {reasons[b.reason]}{b.legacy?' · Older Harbor backup':''}</option>)}</select></label>
    <label className="field"><span>Backup password</span><input autoFocus aria-label="Backup password" type="password" autoComplete="off" required maxLength={1024} disabled={busy} value={password} onChange={e=>{setPassword(e.target.value);clearPreview()}}/></label>
    <button className="button" disabled={busy||!id||!password} type="submit">{busy?'Working…':'Preview backup'}</button>
   </form>}
   {preview&&<div className="recovery-preview"><h3>Verified backup contents</h3><p>The password and encrypted contents were verified. Revision {preview.revision}.</p><dl>{Object.entries(preview.counts).map(([name,count])=><React.Fragment key={name}><dt>{name}</dt><dd>{count}</dd></React.Fragment>)}<dt>Trusted server identities</dt><dd>{preview.knownHosts}</dd></dl>
    <p>Restoring replaces this device’s vault and closes active connections. Harbor first keeps a local copy of the current file. Automatic sync stays off; review the recovered data before syncing again. Newer shared changes may require conflict resolution.</p>
    <label className="recovery-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>Replace this device’s vault with this backup</label>
   </div>}
   {error&&<p className="inline-error" role="alert">{error}</p>}
   <p className="recovery-note">Local backups share this device’s disk. Export an encrypted copy elsewhere to protect against device loss. Use the password from when the backup was created.</p>
  </div>
  <footer><button className="button" disabled={busy} onClick={refresh}>Refresh backups</button><button className="button" disabled={busy} onClick={close}>Cancel</button>{preview&&<button className="button primary" disabled={busy||!confirmed} onClick={restore}>Restore this backup</button>}</footer>
 </section></div>;
}

export function LocalBackups({call,open,notify}) {
 const [info,setInfo]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const refresh=()=>call('vault:backups').then(setInfo);
 useEffect(()=>{refresh().catch(e=>setError(e.message))},[]);
 async function backup(){setBusy(true);setError('');try{await call('vault:backup');await refresh();notify('Encrypted local backup created')}catch(e){setError(e.message)}finally{setBusy(false)}}
 return <div className="local-backups"><div className="setting-row"><div><strong>Automatic local backups</strong><small>Up to {info?.limit||10} unmarked recovery copies, with safety exceptions. Keep-marked and older import backups are additional. Configure count and age limits in Manage backups.</small>{info&&<small>{info.backups.length?`${info.backups.length} available · Latest: ${new Date(info.backups[0].createdAt).toLocaleString()}`:'No backups yet. Your first change creates one, or create one now.'}</small>}</div><button className="button" disabled={busy} onClick={backup}><RefreshCw size={16}/>Back up now</button></div><div className="setting-row"><div><strong>Recover a previous version</strong><small>Preview before replacing. Also available from the locked screen. Backups need their original password and cannot protect against disk loss.</small></div><button className="button" disabled={busy} onClick={open}>Recover backup</button></div>{(error||info?.retention?.error||info?.retention?.lastResult?.error)&&<p className="inline-error" role="alert">{error||info?.retention?.error||info?.retention?.lastResult?.error}</p>}</div>;
}
