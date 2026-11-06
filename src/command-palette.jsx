import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Search,X,Server,Terminal,Grid2X2,Command} from 'lucide-react';
import {searchPalette,hasBlockingDialog} from './command-palette.mjs';
const icons={host:Server,terminal:Terminal,workspace:Grid2X2,action:Command};
export function CommandPalette({Modal,entries,close,select}) {
 const [query,setQuery]=useState(''),[index,setIndex]=useState(0),container=useRef(),submitted=useRef(false),closeRef=useRef(close);
 closeRef.current=close;
 useLayoutEffect(()=>{container.current?.querySelector('input')?.focus()},[]);
 const matches=useMemo(()=>searchPalette(entries,query),[entries,query]),results=matches.slice(0,100);
 const selected=Math.min(index,results.length-1),current=results[selected];
 useEffect(()=>{container.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'})},[selected,query]);
 useEffect(()=>{
  // Authentication or another async prompt always takes priority over this search.
  const observer=new MutationObserver(()=>{if(hasBlockingDialog(container.current?.closest('dialog')))closeRef.current()});
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','aria-modal']});
  return()=>observer.disconnect();
 },[]);
 function choose(entry){if(!entry||entry.disabled||submitted.current||hasBlockingDialog(container.current?.closest('dialog')))return;submitted.current=true;select(entry)}
 return <Modal className="command-palette-dialog" labelledBy="command-palette-title" onClose={close} dismissOnBackdrop>
  <section ref={container} className="command-palette">
   <header><h2 id="command-palette-title">Command palette</h2><button aria-label="Close command palette" onClick={close}><X size={18}/></button></header>
   <div className="palette-search"><Search size={19}/><input autoFocus role="combobox" aria-label="Search hosts, terminals, workspaces and actions" aria-expanded="true" aria-autocomplete="list" aria-controls="palette-results" aria-activedescendant={current?`palette-result-${selected}`:undefined} autoComplete="off" spellCheck="false" placeholder="Where would you like to go?" value={query} onChange={e=>{setQuery(e.target.value);setIndex(0)}} onKeyDown={e=>{
    if(e.nativeEvent.isComposing)return;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setIndex(results.length?(selected+(e.key==='ArrowDown'?1:-1)+results.length)%results.length:0)}
    if(e.key==='Enter'){e.preventDefault();choose(current)}
   }}/></div>
   <div id="palette-results" role="listbox" aria-label="Search results" className="palette-results">
    {results.map((entry,i)=>{const Icon=icons[entry.kind];return <button key={entry.id} id={`palette-result-${i}`} role="option" aria-selected={selected===i} aria-disabled={!!entry.disabled} tabIndex={-1} onMouseMove={()=>setIndex(i)} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(entry)}><Icon size={18}/><span><strong>{entry.label}</strong><small>{entry.detail}{entry.disabled?' · Connection in progress':''}</small></span><span className="palette-kind">{entry.kind}</span></button>})}
   </div>
   <footer><span role="status">{matches.length?`${matches.length} result${matches.length===1?'':'s'}${matches.length>100?' · Showing first 100; refine your search':''}`:'No results found'}</span><span>↑ ↓ Navigate · Enter Open · Esc Close</span></footer>
  </section>
 </Modal>;
}
