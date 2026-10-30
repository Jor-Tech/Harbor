export const colors=['blue','green','purple','orange','pink'];
export const sortOptions=[['name','Name'],['group','Group'],['address','Address'],['created','Creation date'],['updated','Last updated'],['connected','Last connected']];
const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
const compareText=(a,b)=>collator.compare(String(a||''),String(b||''));
export function groupRows(groups){
 const out=[];
 function walk(parent='',prefix='',depth=0){if(depth>16)return;for(const g of groups.filter(g=>(g.parentId||'')===parent).sort((a,b)=>compareText(a.label,b.label))){const label=prefix?prefix+' / '+g.label:g.label;out.push({...g,pathLabel:label,depth});walk(g.id,label,depth+1)}}
 walk();return out;
}
export function inGroup(groups,id,selected){if(selected==='all')return true;if(selected==='ungrouped')return !id;const seen=new Set();while(id&&!seen.has(id)){if(id===selected)return true;seen.add(id);id=groups.find(g=>g.id===id)?.parentId}return false;}
export function hostTags(host){return [...new Set(String(host.tags||'').split(',').map(t=>t.trim()).filter(Boolean))];}
function timestamp(value){const t=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(t)?t:null;}
function localDay(value){const t=timestamp(value);if(t===null)return '';const d=new Date(t);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
export function hostResults(data,{group='all',query='',favorite=false,tag='',color='',from='',to='',groupFilter=false}={}){
 const rows=groupRows(data.groups),paths=new Map(rows.map(g=>[g.id,g.pathLabel]));
 const searching=!!query.trim(),filtered=groupFilter||searching||favorite||!!tag||!!color||!!from||!!to;
 const hierarchical=data.settings.hostsHomeView==='groups'&&!filtered;
 const sort=sortOptions.some(([key])=>key===data.settings.hostSort)?data.settings.hostSort:'name';
 const direction=data.settings.hostSortDirection==='desc'?-1:1;
 const lastConnected=new Map();
 for(const entry of data.history||[]){const t=timestamp(entry.at||entry.connectedAt);if(t!==null&&t>(lastConnected.get(entry.hostId)??-Infinity))lastConnected.set(entry.hostId,t);}
 const dateValue=(host)=>sort==='created'?timestamp(host.createdAt):sort==='updated'?timestamp(host.updatedAt):lastConnected.get(host.id)??null;
 const compare=(a,b)=>{
  let result;
  if(['created','updated','connected'].includes(sort)){
   const left=dateValue(a),right=dateValue(b);
   // Unknown dates always follow known dates, in either direction.
   if(left===null||right===null){if(left!==right)return left===null?1:-1;result=0}else result=(left-right)*direction;
  }else result=compareText(sort==='group'?paths.get(a.groupId)||'':sort==='address'?a.address:a.label,sort==='group'?paths.get(b.groupId)||'':sort==='address'?b.address:b.label)*direction;
  return result||compareText(a.label,b.label)||compareText(a.id,b.id);
 };
 const queryText=query.trim().toLocaleLowerCase();
 const hosts=data.hosts.filter(h=>{
  if(!inGroup(data.groups,h.groupId,group))return false;
  if(hierarchical&&((group==='all'&&h.groupId)||(group!=='all'&&group!=='ungrouped'&&h.groupId!==group)))return false;
  const effective=data.effectiveHosts?.[h.id]||h;
  if(queryText&&![h.label,h.address,effective.username,h.tags,paths.get(h.groupId)].join(' ').toLocaleLowerCase().includes(queryText))return false;
  if(favorite&&!h.favorite||tag&&!hostTags(h).includes(tag)||color&&(h.color||'blue')!==color)return false;
  const day=localDay(h.createdAt);
  if((from||to)&&(!day||from&&day<from||to&&day>to))return false;
  return true;
 }).sort(compare);
 const folders=filtered||group==='ungrouped'?[]:rows.filter(g=>(g.parentId||'')===(group==='all'?'':group));
 if(sort==='name'&&direction===-1)folders.reverse();
 return {hosts,folders,rows,paths,lastConnected,sort,hierarchical,filtered,tags:[...new Set(data.hosts.flatMap(hostTags))].sort(compareText)};
}
