import React,{useCallback,useEffect,useRef,useState} from 'react';
import {BookOpen,X} from 'lucide-react';

export function useWhatsNew(call){
 const [state,setState]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false),[view,setView]=useState(null);
 const attempted=useRef(false),mutation=useRef(0);
 useEffect(()=>{let alive=true;call('whatsNew:status').then(value=>{if(alive)setState(value)}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[call]);
 const configure=async automatic=>{const previous=state;const revision=++mutation.current;setSaving(true);setError('');setState(s=>({...s,automatic,autoShow:automatic&&s.autoShow}));try{const next=await call('whatsNew:configure',{automatic});if(revision===mutation.current)setState(next)}catch(e){if(revision===mutation.current){setState(previous);setError(e.message)}}finally{setSaving(false)}};
 const shown=useCallback(()=>{const revision=mutation.current;call('whatsNew:acknowledge').then(next=>{if(revision===mutation.current)setState(next)}).catch(e=>setError(e.message))},[call]);
 const open=useCallback((automatic=false)=>{if(!state)return;attempted.current=true;setView({automatic,releases:automatic?state.pending:state.releases})},[state]);
 const close=useCallback(()=>setView(null),[]);
 return {state,error,saving,view,attempted,configure,shown,open,close};
}

export function WhatsNewSettings({news}){
 return <div className="whats-new-settings">
  <div className="setting-row"><div><strong>What’s new</strong><small>Short release highlights, available offline.</small></div><button className="button" disabled={!news.state} onClick={()=>news.open()}><BookOpen size={16}/>What’s new{news.state?.pending.length>0&&<span className="whats-new-badge">New</span>}</button></div>
  {news.state&&<NewsPreference news={news}/>}
  {(news.error||news.state?.error)&&<p className="error" role="alert">{news.error||news.state.error}</p>}
 </div>;
}
function NewsPreference({news}){
 return <label className="setting-row update-preference"><div><strong>Show what’s new after updates</strong><small>Show meaningful changes once, after unlocking. Applies only to this device.</small></div><input type="checkbox" role="switch" aria-label="Show what’s new after updates" checked={news.state.automatic} disabled={news.saving} onChange={e=>news.configure(e.target.checked)}/></label>;
}

// Wait for an idle, focused workspace. Dialogs owned by other components (for
// example sync conflicts) also take precedence, even without an App state flag.
export function WhatsNew({news,unlocked,blocked,Modal}){
 const [otherDialog,setOtherDialog]=useState(false);
 useEffect(()=>{
  const check=()=>setOtherDialog(!!document.querySelector('dialog[open]:not(.whats-new-dialog)'));
  const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});check();return()=>observer.disconnect();
 },[]);
 useEffect(()=>{if(!unlocked)news.close()},[unlocked,news.close]);
 useEffect(()=>{
  if(!unlocked||blocked||otherDialog||news.view||!news.state?.autoShow||news.attempted.current)return;
  let timer;
  const schedule=()=>{clearTimeout(timer);if(document.hasFocus()&&document.visibilityState==='visible')timer=setTimeout(()=>{if(document.hasFocus()&&document.visibilityState==='visible'&&!document.querySelector('dialog[open]'))news.open(true)},1200)};
  const events=['focus','blur','pointerdown','keydown'];events.forEach(event=>window.addEventListener(event,schedule));document.addEventListener('visibilitychange',schedule);schedule();
  return()=>{clearTimeout(timer);events.forEach(event=>window.removeEventListener(event,schedule));document.removeEventListener('visibilitychange',schedule)};
 },[unlocked,blocked,otherDialog,news.view,news.state,news.open]);
 if(!unlocked||blocked||otherDialog||!news.view)return null;
 return <NewsDialog news={news} Modal={Modal}/>;
}
function NewsDialog({news,Modal}){
 useEffect(()=>{news.shown()},[news.shown]);
 const {view,state}=news;
 return <Modal className="whats-new-dialog" labelledBy="whats-new-heading" onClose={news.close}>
  <div className="whats-new-content">
   <header><div><span className="whats-new-eyebrow">HARBOR · {state.version}</span><h2 id="whats-new-heading">What’s new in Harbor</h2><p>{view.automatic?'Here’s what changed since your last version.':'Release highlights, right here when you need them.'}</p></div><button aria-label="Close what’s new" onClick={news.close}><X size={20}/></button></header>
   <div className="whats-new-history">
    {view.releases.length?view.releases.map((release,index)=><details key={release.version} open={view.automatic||index===0}><summary><span className="whats-new-version">{release.version}</span><span>{release.title}</span><time dateTime={release.date}>{new Date(release.date+'T12:00:00Z').toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'})}</time></summary><ul>{release.items.map(item=><li key={item}>{item}</li>)}</ul></details>):<p>No release highlights are bundled with this version yet.</p>}
   </div>
   <footer><NewsPreference news={news}/>{(news.error||state.error)&&<p className="error" role="alert">{news.error||state.error}</p>}<div className="whats-new-actions"><button className="button primary" autoFocus onClick={news.close}>Get started</button></div></footer>
  </div>
 </Modal>;
}
