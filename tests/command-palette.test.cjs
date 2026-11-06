'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('palette searches explicit public fields across all four categories',async()=>{
 const {paletteEntries,searchPalette}=await import('../src/command-palette.mjs');
 const entries=paletteEntries({hosts:[{id:'h',label:'Café production',address:'web.example.test',username:'deploy',tags:'web, blue',password:'secret-password',notes:'private-note'}],sessions:[{id:'t',label:'Café production',status:'closed'}],workspaces:[{id:'w',label:'Morning pair'}],actions:[{id:'lock',label:'Lock vault'}]});
 assert.equal(entries.length,4);assert.equal(searchPalette(entries,'CAFE BLUE web.example')[0].target,'h');
 assert.deepEqual(searchPalette(entries,'cafe').map(e=>e.kind),['terminal','host']);
 assert.equal(searchPalette(entries,'morning')[0].kind,'workspace');assert.equal(searchPalette(entries,'lock')[0].kind,'action');
 assert.deepEqual(searchPalette(entries,'secret-password'),[]);assert.deepEqual(searchPalette(entries,'private-note'),[]);
 assert.equal(searchPalette(entries,'  ').length,4);
});
test('exact names rank first and busy state only disables connection actions',async()=>{
 const {paletteEntries,searchPalette}=await import('../src/command-palette.mjs');
 const entries=paletteEntries({busy:true,hosts:[{id:'h',label:'Alpha',address:'alpha.test'}],sessions:[{id:'t',label:'Alpha logs',status:'connected'}],workspaces:[{id:'w',label:'Alpha workspace'}],actions:[{id:'new',label:'New local terminal',disabled:true},{id:'lock',label:'Lock vault'}]});
 assert.equal(searchPalette(entries,'alpha')[0].target,'h');
 assert(entries.find(e=>e.kind==='host').disabled);assert(entries.find(e=>e.kind==='workspace').disabled);assert(!entries.find(e=>e.kind==='terminal').disabled);assert(!entries.find(e=>e.target==='lock').disabled);
});
test('palette shortcut respects platform, modifiers and composition',async()=>{
 const {isPaletteShortcut}=await import('../src/command-palette.mjs');
 assert(isPaletteShortcut({key:'K',ctrlKey:true},'linux'));assert(isPaletteShortcut({key:'k',metaKey:true},'darwin'));
 for(const extra of [{shiftKey:true},{altKey:true},{metaKey:true},{isComposing:true}])assert(!isPaletteShortcut({key:'k',ctrlKey:true,...extra},'linux'));
 assert(!isPaletteShortcut({key:'k',ctrlKey:true},'darwin'));assert(!isPaletteShortcut({key:'k',metaKey:true},'win32'));
});
