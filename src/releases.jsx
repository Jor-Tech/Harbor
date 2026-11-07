import React,{useEffect,useState} from 'react';
import {ExternalLink,RefreshCw,Download} from 'lucide-react';
import {WhatsNewSettings} from './whats-new.jsx';

export function useUpdates(call){
 const [state,setState]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 useEffect(()=>{let alive=true;const off=window.harbor?.on('updates:changed',s=>{if(alive)setState(s)});call('updates:status').then(s=>{if(alive)setState(s)}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false;off?.()}},[call]);
 const check=async()=>{setError('');try{setState(await call('updates:check'))}catch(e){setError(e.message)}};
 const configure=async value=>{const previous=state;setSaving(true);setError('');setState(s=>({...s,preferences:{...s.preferences,...value}}));try{setState(await call('updates:configure',value))}catch(e){setState(previous);setError(e.message)}finally{setSaving(false)}};
 return {state,error,saving,check,configure};
}
export function UpdateNotice({updates,onOpen}){
 if(updates.state?.phase!=='available')return null;
 return <button className="update-notice" title={`Harbor ${updates.state.latest.version} is available`} aria-label="View available update" onClick={onOpen}><Download size={15}/><span>Update available</span></button>;
}
export function Releases({call,updates,news}) {
 const [info,setInfo]=useState(null),[error,setError]=useState(''),[opening,setOpening]=useState(false);
 const {state,saving,check,configure}=updates;
 useEffect(()=>{let active=true;call('releases:info').then(value=>{if(active)setInfo(value)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[call]);
 const open=async action=>{setOpening(true);setError('');try{await call(action)}catch(e){setError(e.message)}finally{setOpening(false)}};
 const messages={idle:'No update check yet.',checking:'Checking for updates…',available:`Harbor ${state?.latest?.version} is available.`,current:'You are up to date for the selected release channel.',empty:'No compatible published releases were found for the selected channel.',error:state?.error};
 return <section className="release-settings" aria-labelledby="release-heading">
    <h2 id="release-heading">Releases & updates</h2>
    <p>Choose when Harbor checks for new releases. Downloads and installation stay under your control.</p>
    {info&&<div className="setting-row"><div><strong>Running version</strong><small>{info.platform} · {info.arch} · {info.packaged?'Installed app':'Development build'}</small></div><span className="release-version">{info.version}<small>{info.preview?'Preview':'Stable version'}</small></span></div>}
    {state&&<>
      <label className="setting-row update-preference"><div><strong>Automatically check for updates</strong><small>Check shortly after launch and every 12 hours while Harbor is running.</small></div><input type="checkbox" role="switch" aria-label="Automatically check for updates" checked={state.preferences.automatic} disabled={saving} onChange={e=>configure({automatic:e.target.checked})}/></label>
      <label className="setting-row update-preference"><div><strong>Include preview releases</strong><small>Also notify me about alpha, beta and other prereleases.</small></div><input type="checkbox" role="switch" aria-label="Include preview releases" checked={state.preferences.includePreviews} disabled={saving} onChange={e=>configure({includePreviews:e.target.checked})}/></label>
      <div className={'update-status '+(state.phase==='available'?'is-available':'')} role="status" aria-live="polite"><strong>{messages[state.phase]}</strong>{state.lastChecked&&<small>Last checked: {new Date(state.lastChecked).toLocaleString()}</small>}</div>
    </>}
    <div className="release-actions"><button className="button primary" disabled={!state||saving||state.phase==='checking'} onClick={check}><RefreshCw size={16}/>{state?.phase==='checking'?'Checking…':'Check now'}</button>{state?.phase==='available'&&<button className="button" disabled={opening} onClick={()=>open('updates:open')}><Download size={16}/>View update & download</button>}<button className="button" disabled={opening} onClick={()=>open('releases:open')}><ExternalLink size={16}/>View releases & downloads</button></div>
    <p className="release-hint">Checks contact GitHub for public release information. No vault data or credentials are sent. Preferences apply only to this device. Automatic checking is off by default.</p>
    <p className="release-hint">To update, quit Harbor, install the new version, then reopen it. Harbor never downloads, installs or restarts automatically. Your vault and local MCP settings stay on this device.</p>
    <WhatsNewSettings news={news}/>
    {(error||updates.error)&&<p className="error" role="alert">{error||updates.error}</p>}
  </section>;
}
