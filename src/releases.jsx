import React,{useEffect,useState} from 'react';
import {ExternalLink,RefreshCw,Download} from 'lucide-react';
import {WhatsNewSettings} from './whats-new.jsx';

export function useUpdates(call){
 const [state,setState]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 useEffect(()=>{let alive=true;const off=window.harbor?.on('updates:changed',s=>{if(alive)setState(s)});call('updates:status').then(s=>{if(alive)setState(s)}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false;off?.()}},[call]);
 const check=async()=>{setError('');try{setState(await call('updates:check'))}catch(e){setError(e.message)}};
 const installAction=async action=>{setError('');try{setState(await call(`updates:${action}`))}catch(e){setError(e.message)}};
 const configure=async value=>{const previous=state;setSaving(true);setError('');setState(s=>({...s,preferences:{...s.preferences,...value}}));try{setState(await call('updates:configure',value))}catch(e){setState(previous);setError(e.message)}finally{setSaving(false)}};
 return {state,error,saving,check,configure,installAction};
}
export function UpdateNotice({updates,onOpen}){
 const ready=updates.state?.installation?.phase==='downloaded';
 if(updates.state?.phase!=='available'&&!ready)return null;
 return <button className="update-notice" title={ready?`Harbor ${updates.state.installation.version} is ready to install`:`Harbor ${updates.state.latest.version} is available`} aria-label="View available update" onClick={onOpen}><Download size={15}/><span>{ready?'Update ready':'Update available'}</span></button>;
}
export function Releases({call,updates,news}) {
 const [info,setInfo]=useState(null),[error,setError]=useState(''),[opening,setOpening]=useState(false);
 const {state,saving,check,configure,installAction}=updates;
 const installation=state?.installation;
 const installing=installation?.phase==='installing';
 const downloading=['preparing','downloading'].includes(installation?.phase);
 const ready=installation?.phase==='downloaded';
 const updateActive=downloading||ready||installing;
 const canDownload=state?.phase==='available'&&installation?.supported&&!updateActive;
 useEffect(()=>{let active=true;call('releases:info').then(value=>{if(active)setInfo(value)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[call]);
 const open=async action=>{setOpening(true);setError('');try{await call(action)}catch(e){setError(e.message)}finally{setOpening(false)}};
 const messages={idle:'No update check yet.',checking:'Checking for updates…',available:`Harbor ${state?.latest?.version} is available.`,current:'You are up to date for the selected release channel.',empty:'No compatible published releases were found for the selected channel.',error:state?.error};
 return <section className="release-settings" aria-labelledby="release-heading">
    <h2 id="release-heading">Releases & updates</h2>
    <p>Choose when Harbor checks for new releases. Downloads and installation stay under your control.</p>
    {info&&<div className="setting-row"><div><strong>Running version</strong><small>{info.platform} · {info.arch} · {info.packaged?'Installed app':'Development build'}</small></div><span className="release-version">{info.version}<small>{info.preview?'Preview':'Stable version'}</small></span></div>}
    {state&&<>
      <label className="setting-row update-preference"><div><strong>Automatically check for updates</strong><small>Check shortly after launch and every 12 hours while Harbor is running.</small></div><input type="checkbox" role="switch" aria-label="Automatically check for updates" checked={state.preferences.automatic} disabled={saving} onChange={e=>configure({automatic:e.target.checked})}/></label>
      <label className="setting-row update-preference"><div><strong>Include preview releases</strong><small>Also notify me about alpha, beta and other prereleases.</small></div><input type="checkbox" role="switch" aria-label="Include preview releases" checked={state.preferences.includePreviews} disabled={saving||updateActive} onChange={e=>configure({includePreviews:e.target.checked})}/></label>
      <div className={'update-status '+(state.phase==='available'?'is-available':'')} role="status" aria-live="polite"><strong>{messages[state.phase]}</strong>{state.lastChecked&&<small>Last checked: {new Date(state.lastChecked).toLocaleString()}</small>}</div>
      {updateActive&&<div className="update-installation" role="status" aria-live="polite">
       <strong>{installation.phase==='preparing'?'Preparing download…':installation.phase==='downloading'?`Downloading Harbor ${installation.version}… ${installation.percent}%`:ready?`Harbor ${installation.version} is ready to install.`:'Installing update…'}</strong>
       {installation.phase==='downloading'&&<progress aria-label="Update download progress" max="100" value={installation.percent}/>}
       {ready&&<p>You can keep working and install later. Installation closes Harbor and disconnects active sessions.</p>}
      </div>}
      {installation?.error&&<p className="error" role="alert">{installation.error}</p>}
    </>}
    <div className="release-actions">
     {canDownload&&<button className="button primary" disabled={saving} onClick={()=>installAction('download')}><Download size={16}/>{installation.phase==='error'?'Retry download':'Download update'}</button>}
     {ready&&<button className="button primary" onClick={()=>installAction('install')}><RefreshCw size={16}/>Install and restart</button>}
     {installation?.phase==='downloading'&&<button className="button" onClick={()=>installAction('cancel')}>Cancel download</button>}
     {ready&&<button className="button" onClick={()=>installAction('discard')}>Dismiss update</button>}
     <button className={'button '+(!canDownload&&!updateActive?'primary':'')} disabled={!state||saving||state.phase==='checking'||updateActive} onClick={check}><RefreshCw size={16}/>{state?.phase==='checking'?'Checking…':'Check now'}</button>
     <button className="button" disabled={opening} onClick={()=>open('releases:open')}><ExternalLink size={16}/>View releases & downloads</button>
    </div>
    <p className="release-hint">Checks contact GitHub for public release information. No vault data or credentials are sent. Preferences apply only to this device. Automatic checking is off by default.</p>
    <p className="release-hint">{installation?.supported?'Download an update here, then choose Install and restart when you are ready. Harbor only downloads and installs when you ask. Your vault and local MCP settings are preserved.':installation?.reason||'Use View releases & downloads to install an update manually.'}</p>
    <WhatsNewSettings news={news}/>
    {(error||updates.error)&&<p className="error" role="alert">{error||updates.error}</p>}
  </section>;
}
