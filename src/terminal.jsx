import React,{useEffect,useRef,useState} from 'react';
import {Terminal,Search,FolderOpen,Trash2,RefreshCw,X,ArrowUp,ArrowDown} from 'lucide-react';
import {Terminal as XTerminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {SearchAddon} from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';

const decorations={matchBackground:'#635526',matchOverviewRuler:'#e0b850',activeMatchBackground:'#975a15',activeMatchColorOverviewRuler:'#ffbe50'};
export function TerminalPane({session,visible,fontSize,buffers,terminalRefs,notify,onSftp,onInput,call}){
 const el=useRef(),fit=useRef(),term=useRef(),search=useRef(),inputRef=useRef(onInput),sessionRef=useRef(session),searchInput=useRef();
 inputRef.current=onInput;sessionRef.current=session;
 const [searching,setSearching]=useState(false),[query,setQuery]=useState(''),[caseSensitive,setCase]=useState(false),[wholeWord,setWhole]=useState(false),[result,setResult]=useState(null),[now,setNow]=useState(Date.now());
 const connected=session.status==='connected',pending=session.pending||['reconnecting','authenticating','cancelling'].includes(session.status),waiting=session.status==='waiting';
 const shortcut=window.harbor?.platform==='darwin'?'⌘ F':'Ctrl Shift F';
 const action=(name,args={})=>call(name,{id:session.id,...args}).catch(e=>notify(e.message,true));
 const closeSearch=()=>{setSearching(false);search.current?.clearDecorations();term.current?.focus()};
 function find(backward=false,incremental=false){
  if(!query){search.current?.clearDecorations();setResult(null);return;}
  const found=search.current?.[backward?'findPrevious':'findNext'](query,{caseSensitive,wholeWord,incremental,decorations});
  if(!found)setResult({resultCount:0,resultIndex:-1});
 }
 useEffect(()=>{
  const t=new XTerminal({allowProposedApi:true,fontFamily:'"DejaVu Sans Mono", "Liberation Mono", monospace',fontSize,cursorBlink:true,scrollback:10000,theme:{background:'#141729',foreground:'#e3e6f0',cursor:'#60b5ff',selectionBackground:'#435577',black:'#282b3d',red:'#ff738a',green:'#7cdb9b',yellow:'#f2d083',blue:'#6daeff',magenta:'#bb9af7',cyan:'#7dcfff',white:'#e3e6f0'}});
  const f=new FitAddon(),s=new SearchAddon({highlightLimit:1000});t.loadAddon(f);t.loadAddon(s);t.open(el.current);term.current=t;fit.current=f;search.current=s;
  terminalRefs.current.set(session.id,t);
  const buffered=buffers.current.get(session.id);if(buffered){t.write(buffered);buffers.current.delete(session.id)}
  const d=t.onData(data=>{if(sessionRef.current.status==='connected')inputRef.current(session.id,data)});
  const r=t.onResize(({cols,rows})=>{if(sessionRef.current.status==='connected')call('terminal:resize',{id:session.id,cols,rows}).catch(()=>{})});
  const results=s.onDidChangeResults(setResult);
  const observer=new ResizeObserver(()=>{if(el.current?.offsetWidth)f.fit()});observer.observe(el.current);
  return()=>{observer.disconnect();d.dispose();r.dispose();results.dispose();terminalRefs.current.delete(session.id);t.dispose()};
 },[]);
 useEffect(()=>{if(visible){const frame=requestAnimationFrame(()=>{fit.current?.fit();if(searching)searchInput.current?.focus();else term.current?.focus()});return()=>cancelAnimationFrame(frame)}},[visible]);
 useEffect(()=>{if(term.current){term.current.options.fontSize=fontSize;fit.current.fit()}},[fontSize]);
 useEffect(()=>{if(term.current){term.current.options.disableStdin=!connected;if(connected)call('terminal:resize',{id:session.id,cols:term.current.cols,rows:term.current.rows}).catch(()=>{})}},[connected]);
 useEffect(()=>{if(searching){searchInput.current?.focus();search.current?.clearDecorations();find(false,true)}else search.current?.clearDecorations();fit.current?.fit()},[searching,query,caseSensitive,wholeWord]);
 useEffect(()=>{if(!waiting)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),500);return()=>clearInterval(timer)},[waiting,session.nextRetryAt]);
 const seconds=Math.max(0,Math.ceil(((session.nextRetryAt||now)-now)/1000));
 const label=connected?'Connected':waiting?`Reconnecting in ${seconds}s · attempt ${session.attempt+1}/${session.maxAttempts}`:session.status==='authenticating'?'Waiting for authentication':session.status==='reconnecting'?`Reconnecting${session.attempt?` · attempt ${session.attempt}/${session.maxAttempts}`:''}`:session.status==='cancelling'?'Cancelling…':session.reason==='ended'?'Remote session ended':session.reason==='exit'?'Session ended':session.exhausted?'Reconnect attempts exhausted':'Disconnected';
 return <section className="terminal-pane" aria-label={`${session.label} terminal`} style={{display:visible?'flex':'none'}} onKeyDownCapture={e=>{
  const mac=window.harbor?.platform==='darwin';
  const copy=e.key.toLowerCase()==='c'&&!e.altKey&&(mac?e.metaKey&&!e.ctrlKey&&!e.shiftKey:e.ctrlKey&&e.shiftKey&&!e.metaKey);
  if(copy&&el.current?.contains(e.target)){
   e.preventDefault();e.stopPropagation();
   const text=term.current?.getSelection();
   if(text)call('clipboard:write',{text}).catch(error=>notify(error.message,true));
   return;
  }
  if(e.key.toLowerCase()==='f'&&(mac?e.metaKey:e.ctrlKey&&e.shiftKey)){e.preventDefault();e.stopPropagation();setSearching(true);searchInput.current?.focus();searchInput.current?.select()}
 }}>
  <div className="terminal-toolbar"><span><Terminal size={15}/>{session.label}<i className="protocol">{session.local?'LOCAL':session.sessionRef?'SSH · TMUX':'SSH'}</i></span><div>
   <button title={`Search terminal (${shortcut})`} aria-label="Search terminal" onClick={()=>{setSearching(true);searchInput.current?.focus()}}><Search size={16}/></button>
   {!session.local&&<button className="button" disabled={!connected} onClick={onSftp}><FolderOpen size={15}/>Open SFTP</button>}
   {connected?<button className="button" disabled={pending} onClick={()=>action('terminal:cancelReconnect')}>Disconnect</button>:pending||waiting?<button className="button" disabled={session.status==='cancelling'} onClick={()=>action('terminal:cancelReconnect')}>Cancel reconnect</button>:<button className="button" title={session.sessionRef?"Resume remote tmux session; create an empty session if it ended":"Start a new session; previous commands are not replayed"} onClick={()=>action('terminal:reconnect')}><RefreshCw size={15}/>{session.local?'Restart shell':'Reconnect'}</button>}
   {session.sessionRef&&<button className="button" disabled={!connected||pending} onClick={()=>{if(window.confirm('End this remote tmux session and stop its running processes? Other terminals attached to this same session will also disconnect.'))action('terminal:terminate')}}>End remote session</button>}
   <button title="Clear terminal" onClick={()=>{term.current?.clear();search.current?.clearDecorations();setResult(null)}}><Trash2 size={15}/></button>
  </div></div>
  {searching&&<form className="terminal-search" role="search" aria-label="Search terminal scrollback" onSubmit={e=>{e.preventDefault();find()}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeSearch()}else if(e.key==='Enter'&&e.shiftKey){e.preventDefault();find(true)}}}>
   <input ref={searchInput} aria-label="Find in terminal" placeholder="Find in scrollback…" value={query} onChange={e=>setQuery(e.target.value)} autoComplete="off" spellCheck="false" maxLength={1000}/>
   <span className="search-result" role="status">{!query?'':result?.resultCount===0?'No matches':result?.resultIndex===-1?'Many matches':result?`${result.resultIndex+1} of ${result.resultCount}${result.resultCount>=1000?' +':''}`:''}</span>
   <button type="button" aria-label="Match case" title="Match case" aria-pressed={caseSensitive} onClick={()=>setCase(v=>!v)}>Aa</button><button type="button" aria-label="Whole word" title="Whole word" aria-pressed={wholeWord} onClick={()=>setWhole(v=>!v)}>Ab</button>
   <button type="button" aria-label="Previous match" title="Previous match (Shift Enter)" disabled={!query} onClick={()=>find(true)}><ArrowUp size={15}/></button><button type="submit" aria-label="Next match" title="Next match (Enter)" disabled={!query}><ArrowDown size={15}/></button><button type="button" aria-label="Close terminal search" title="Close search (Esc)" onClick={closeSearch}><X size={15}/></button>
  </form>}
  <div className="terminal-container" ref={el}/>
  <div className="terminal-connection"><span className={'connection-label '+(connected?'connected':'')} role="status"><i className={'dot '+(connected?'online':'')}/>{label}</span>{!session.local&&<label title="Retry dropped SSH connections up to five times. Authentication may be requested again."><input type="checkbox" checked={!!session.autoReconnect} onChange={e=>action('terminal:autoReconnect',{enabled:e.target.checked})}/>Auto reconnect this tab</label>}</div>
  {!connected&&<div className="terminal-disconnected">{session.error&&<p>{session.error}</p>}<p>{pending||waiting?'You can cancel at any time. Authentication may be requested again.':session.reason==='locked'?'Vault unlocked. Reconnect to resume your remote tmux session. Authentication is required again; previous terminal output was cleared.':session.sessionRef?'Disconnect leaves the remote session running. Reconnect resumes it, or creates an empty session if it has ended. No commands are replayed.':'Scrollback is preserved. Reconnect opens a new shell; enable tmux in host settings to preserve future sessions.'}</p></div>}
 </section>
}
