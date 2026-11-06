const normalize=value=>String(value??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
// Explicit display fields only: never index credentials, notes or snippet commands.
export function paletteEntries({hosts=[],sessions=[],workspaces=[],actions=[],busy=false}) {
 return [
  ...sessions.map(s=>({id:`terminal:${s.id}`,kind:'terminal',target:s.id,label:s.label,detail:`Open terminal · ${s.status}`,keywords:s.local?'local shell':'ssh terminal'})),
  ...hosts.map(h=>({id:`host:${h.id}`,kind:'host',target:h.id,label:h.label,detail:`Connect · ${h.username?h.username+'@':''}${h.address}:${h.port||22}`,keywords:String(h.tags||''),disabled:busy})),
  ...workspaces.map(w=>({id:`workspace:${w.id}`,kind:'workspace',target:w.id,label:w.label,detail:'Restore saved workspace',disabled:busy})),
  ...actions.map(a=>({id:`action:${a.id}`,kind:'action',target:a.id,label:a.label,detail:a.detail||'Action',disabled:!!a.disabled})),
 ];
}
export function searchPalette(entries,query) {
 const words=normalize(query).trim().split(/\s+/).filter(Boolean),phrase=words.join(' ');
 return entries.map((entry,index)=>{
  const label=normalize(entry.label),text=normalize([entry.label,entry.detail,entry.keywords,entry.kind].join(' '));
  return {entry,index,match:words.every(word=>text.includes(word)),rank:label===phrase?0:label.startsWith(phrase)?1:2};
 }).filter(r=>r.match).sort((a,b)=>a.rank-b.rank||a.index-b.index).map(r=>r.entry);
}
export function isPaletteShortcut(event,platform) {
 return event.key.toLowerCase()==='k'&&!event.altKey&&!event.shiftKey&&!event.isComposing&&
  (platform==='darwin'?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey);
}
export function hasBlockingDialog(except=null) {
 return [...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]')]
  .some(element=>element!==except&&element.checkVisibility());
}
