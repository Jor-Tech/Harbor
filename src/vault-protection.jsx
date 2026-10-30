import React,{useEffect,useState} from 'react';
import {Shield,Lock,X} from 'lucide-react';

export function VaultProtection({call,data,notify}) {
 const [info,setInfo]=useState(null),[open,setOpen]=useState(false),[password,setPassword]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let active=true;call('vault:security').then(v=>{if(active)setInfo(v)}).catch(()=>{if(active)setInfo(null)});return()=>{active=false}},[data,call]);
 function close(){setOpen(false);setPassword('');setConfirmed(false);setError('')}
 async function upgrade(e){
  e.preventDefault();setBusy(true);setError('');
  try{await call('vault:upgradeEncryption',{password,confirm:confirmed});setPassword('');setInfo(await call('vault:security'));close();notify('Vault updated.');}
  catch(e){setError(e.message)}finally{setBusy(false)}
 }
 if(!info)return null;
 return <>
  {info.needsUpgrade&&<div className="vault-protection-banner"><Shield size={20}/><div><strong>Vault format update available</strong><p>Update this vault to Harbor’s current format.</p></div><button className="button" onClick={()=>setOpen(true)}>Update vault format</button></div>}
  {open&&<div className="auth-overlay"><form className="auth-dialog protection-dialog" role="dialog" aria-modal="true" aria-labelledby="protection-title" onSubmit={upgrade}>
   <div className="auth-heading"><Lock size={24}/><h2 id="protection-title">Update vault format</h2><button type="button" aria-label="Close vault update" disabled={busy} onClick={close}><X size={18}/></button></div>
   <p>Your password stays the same. Harbor verifies it, keeps an encrypted recovery copy, then updates the current vault.</p>
   <p>Update Harbor on every device first. All devices need a compatible Harbor version. When syncing, update the other copies too, or import the updated shared vault. Preserve any unsynced edits first.</p>
   <p>This updates only the current vault. Backups, exports and shared history remain unchanged. After checking the update, make a new export. A strong, unique vault password is still essential.</p>
   <label className="field"><span>Current vault password</span><input aria-label="Current vault password" type="password" autoComplete="current-password" required maxLength={1024} autoFocus disabled={busy} value={password} onChange={e=>{setPassword(e.target.value);setError('')}}/></label>
   <label className="protection-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>I have updated Harbor on my devices and want to update this vault.</label>
   {error&&<p role="alert" className="error-text">{error}</p>}
   <div className="auth-actions"><button className="button" type="button" disabled={busy} onClick={close}>Cancel</button><button className="button primary" type="submit" disabled={busy||!confirmed||!password}>{busy?'Updating…':'Update this vault'}</button></div>
  </form></div>}
 </>;
}
