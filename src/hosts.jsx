import React,{useState} from 'react';
import {Folder,Server,Star,ChevronRight,MoreHorizontal,ArrowUpRight,ArrowUp,ArrowDown,Grid2X2,List,SlidersHorizontal,Search} from 'lucide-react';
import {colors,sortOptions,hostResults,inGroup} from './host-browser.mjs';

export function HostsBrowser({data,group,setGroup,query,setQuery,favorite,setFavorite,view,setView,setEditor,save,run,connect,busy,openNew,savePreferences,notify}){
 const [filtersOpen,setFiltersOpen]=useState(false),[groupFilter,setGroupFilter]=useState(false),[tag,setTag]=useState(''),[color,setColor]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[saving,setSaving]=useState(false);
 const result=hostResults(data,{group,query,favorite,tag,color,from,to,groupFilter});
 const selectedGroup=data.groups.find(g=>g.id===group);
 const filterCount=[group!=='all',favorite,!!tag,!!color,!!from,!!to].filter(Boolean).length;
 const preference=async value=>{setSaving(true);try{await savePreferences(value)}catch(e){notify(e.message,true)}finally{setSaving(false)}};
 const clear=()=>{setGroupFilter(false);setTag('');setColor('');setFrom('');setTo('');setFavorite(false);setQuery('')};
 const browse=id=>{clear();setGroup(id)};
 const dateLabel=host=>{
  if(result.sort==='created')return 'Created: '+formatDate(host.createdAt);
  if(result.sort==='updated')return 'Updated: '+formatDate(host.updatedAt);
  if(result.sort==='connected'){const time=result.lastConnected.get(host.id);return time===undefined?'No connection in history':'Connected: '+new Date(time).toLocaleDateString();}
  return '';
 };
 const trail=[];let parent=selectedGroup;
 while(parent&&trail.length<16){trail.unshift(parent);parent=data.groups.find(g=>g.id===parent.parentId)}
 return <section className="hosts-browser" aria-label="Host browser">
  <div className="host-browser-controls">
   <label className="host-home-control">Hosts page<select aria-label="Hosts page display" value={data.settings.hostsHomeView||'all'} disabled={saving} onChange={e=>preference({hostsHomeView:e.target.value})}><option value="all">All hosts</option><option value="groups">Groups and ungrouped hosts</option></select></label>
   <div className="host-sort-controls"><label>Sort by<select aria-label="Sort hosts by" value={result.sort} disabled={saving} onChange={e=>preference({hostSort:e.target.value})}>{sortOptions.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <button className="button sort-direction" aria-label={data.settings.hostSortDirection==='desc'?'Sort ascending':'Sort descending'} title={data.settings.hostSortDirection==='desc'?'Descending — click for ascending':'Ascending — click for descending'} disabled={saving} onClick={()=>preference({hostSortDirection:data.settings.hostSortDirection==='desc'?'asc':'desc'})}>{data.settings.hostSortDirection==='desc'?<ArrowDown size={16}/>:<ArrowUp size={16}/>}</button>
    <button className={'button '+(filtersOpen?'selected-filter':'')} aria-expanded={filtersOpen} aria-controls="host-filters" onClick={()=>setFiltersOpen(v=>!v)}><SlidersHorizontal size={15}/>Filters{filterCount>0&&<b>{filterCount}</b>}</button>
    <div className="view-toggle"><button className={view==='grid'?'active':''} aria-pressed={view==='grid'} title="Grid view" onClick={()=>setView('grid')}><Grid2X2 size={15}/></button><button className={view==='list'?'active':''} aria-pressed={view==='list'} title="List view" onClick={()=>setView('list')}><List size={17}/></button></div>
   </div>
  </div>
  {filtersOpen&&<div id="host-filters" className="host-filter-panel">
   <label>Group<select aria-label="Filter by group" value={group} onChange={e=>{setGroupFilter(e.target.value!=='all');setGroup(e.target.value)}}><option value="all">All groups</option><option value="ungrouped">Ungrouped hosts</option>{result.rows.map(g=><option key={g.id} value={g.id}>{g.pathLabel}</option>)}</select></label>
   <label>Tag<select aria-label="Filter by tag" value={tag} onChange={e=>setTag(e.target.value)}><option value="">All tags</option>{result.tags.map(t=><option key={t}>{t}</option>)}</select></label>
   <label>Host color<select aria-label="Filter by host color" value={color} onChange={e=>setColor(e.target.value)}><option value="">All colors</option>{colors.map(c=><option key={c} value={c}>{c[0].toUpperCase()+c.slice(1)}</option>)}</select></label>
   <label>Created from<input type="date" aria-label="Created from" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Created through<input type="date" aria-label="Created through" value={to} onChange={e=>setTo(e.target.value)}/></label>
   <label className="favorites-filter"><input type="checkbox" checked={favorite} onChange={e=>setFavorite(e.target.checked)}/>Favorites only</label>
   {from&&to&&from>to&&<p className="filter-help" role="alert">The start date must be on or before the end date.</p>}
   {(from||to)&&<p className="filter-help">Dates use your local time. Older hosts without a recorded creation date are excluded.</p>}
  </div>}
  <div className="host-location"><div className="host-breadcrumbs"><button onClick={()=>browse('all')}>Hosts</button>{trail.map(g=><React.Fragment key={g.id}><ChevronRight size={13}/><button onClick={()=>browse(g.id)}>{g.label}</button></React.Fragment>)}{group==='ungrouped'&&<><ChevronRight size={13}/><span>Ungrouped</span></>}</div>{(result.filtered||group!=='all')&&<button className="clear-host-filters" onClick={()=>{clear();setGroup('all')}}>Clear filters</button>}</div>
  <div className="host-results-summary" aria-live="polite"><strong>{result.hosts.length} {result.hosts.length===1?'host':'hosts'}{result.folders.length>0&&` · ${result.folders.length} ${result.folders.length===1?'group':'groups'}`}</strong><span>{result.filtered?(group==='all'?'Searching across all groups':group==='ungrouped'?'Ungrouped hosts only':'Includes hosts in subgroups'):result.hierarchical?'Groups and directly assigned hosts':group==='all'?'All saved hosts':'Includes hosts in subgroups'}</span></div>
  {result.folders.length>0&&<div className="folder-grid">{result.folders.map(g=><div className={'folder-card group-color-'+(colors.includes(g.color)?g.color:'blue')} key={g.id}><button onClick={()=>browse(g.id)}><Folder className="group-marker" size={23}/><span><strong>{g.label}</strong><small>{data.hosts.filter(h=>inGroup(data.groups,h.groupId,g.id)).length} hosts</small></span><ChevronRight size={16}/></button><button title="Edit group" aria-label={`Edit group ${g.label}`} onClick={()=>setEditor({kind:'groups',item:data.groups.find(item=>item.id===g.id)})}><MoreHorizontal size={17}/></button></div>)}</div>}
  <div className={'host-grid '+(view==='list'?'list-view':'')}>{result.hosts.map(h=>{
   const effective=data.effectiveHosts?.[h.id]||h,g=data.groups.find(g=>g.id===h.groupId);
   return <div key={h.id} className="host-card" onDoubleClick={()=>connect(h)}><div className={'host-icon '+(h.color||'blue')}><Server size={25} strokeWidth={1.5}/></div><button title={`${h.label} · ${effective.username?effective.username+'@':''}${h.address}`} className="host-body" onClick={()=>setEditor({kind:'hosts',item:h})}><strong>{h.label}</strong><span>{effective.username?effective.username+'@':''}{h.address}</span><div className="host-tags"><i>SSH</i>{h.tags&&String(h.tags).split(',').filter(Boolean).slice(0,2).map(t=><i key={t}>{t.trim()}</i>)}</div>{dateLabel(h)&&<small className="host-date">{dateLabel(h)}</small>}</button><button aria-pressed={!!h.favorite} title={h.favorite?'Remove favorite':'Favorite host'} className={'favorite '+(h.favorite?'is-favorite':'')} onClick={()=>run(()=>save('hosts',{...h,favorite:!h.favorite}))}><Star size={15} fill={h.favorite?'currentColor':'none'}/></button><div className="host-footer"><span><span className="dot"/> {effective.port||22} <span className={'host-group group-color-'+(colors.includes(g?.color)?g.color:'blue')} title={result.paths.get(h.groupId)||'Ungrouped'}>{g&&<Folder className="group-marker" size={11}/>} {g?.label||'Ungrouped'}</span></span><button disabled={busy} onClick={()=>connect(h)}>Connect <ArrowUpRight size={14}/></button></div></div>;
  })}</div>
  {!result.hosts.length&&!result.folders.length&&<div className="host-browser-empty"><Search size={30}/><h2>{result.filtered?'No matching hosts':group==='all'?'Your servers. One workspace.':'This group is empty'}</h2><p>{result.filtered?'Try another search or clear your filters.':'Add a host here or choose another group.'}</p>{result.filtered?<button className="button" onClick={()=>{clear();setGroup('all')}}>Clear filters</button>:<button className="button primary" onClick={()=>openNew('hosts')}>Add host</button>}</div>}
  {['created','updated','connected'].includes(result.sort)&&<p className="host-date-help">{result.sort==='connected'?'Last connection uses the retained connection history.':'Older hosts may not have a recorded date.'} Unknown dates appear last.</p>}
 </section>;
}
function formatDate(value){const time=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(time)?new Date(time).toLocaleDateString():'Unknown';}
