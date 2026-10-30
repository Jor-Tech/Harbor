'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {hostResults}=require('../src/host-browser.mjs');
const {withMetadata}=require('../electron/entity-metadata.cjs');
const {parseConfig,applyImport}=require('../electron/ssh-config.cjs');
const {initialData}=require('../electron/vault.cjs');
function fixture(){return {...initialData(),groups:[{id:'prod',label:'Production',color:'green'},{id:'web',label:'Web',parentId:'prod',color:'purple'},{id:'dev',label:'Development'}],hosts:[{id:'a',label:'Server 10',address:'z.test',groupId:'prod',tags:'prod, web',createdAt:'2026-01-02T12:00:00Z',color:'green'},{id:'b',label:'Server 2',address:'b.test',groupId:'web',tags:'web',favorite:true,createdAt:'2026-01-03T12:00:00Z',updatedAt:'2026-02-01T12:00:00Z'},{id:'c',label:'Legacy',address:'a.test',groupId:'',updatedAt:'2026-01-01T00:00:00Z'}]};}
const ids=r=>r.hosts.map(h=>h.id);
test('all-host and hierarchical browsing handle root, child groups and ungrouped hosts',()=>{
 const d=fixture();assert.deepEqual(ids(hostResults(d)),['c','b','a']);assert.deepEqual(hostResults(d).folders.map(g=>g.id),['dev','prod']);
 d.settings.hostsHomeView='groups';assert.deepEqual(ids(hostResults(d)),['c']);assert.deepEqual(ids(hostResults(d,{group:'prod'})),['a']);assert.deepEqual(hostResults(d,{group:'prod'}).folders.map(g=>g.id),['web']);assert.deepEqual(ids(hostResults(d,{group:'web'})),['b']);assert.deepEqual(ids(hostResults(d,{group:'ungrouped'})),['c']);
});
test('search and combined filters reach nested hosts without leaving the selected group',()=>{
 const d=fixture();d.settings.hostsHomeView='groups';d.effectiveHosts={b:{username:'inherited-user'}};
 assert.deepEqual(ids(hostResults(d,{query:'inherited-user'})),['b']);assert.deepEqual(ids(hostResults(d,{group:'prod',tag:'web',favorite:true})),['b']);assert.equal(hostResults(d,{tag:'web'}).folders.length,0);
 assert.deepEqual(ids(hostResults(d,{group:'prod',groupFilter:true})),['b','a']);assert.deepEqual(ids(hostResults(d,{group:'dev',tag:'web'})),[]);assert.deepEqual(ids(hostResults(d,{color:'green'})),['a']);assert.deepEqual(ids(hostResults(d,{query:'production / web'})),['b']);assert.deepEqual(ids(hostResults(d,{group:'ungrouped',tag:'web'})),[]);
});
test('sorting is numeric and stable, supports group/address/history, and keeps unknown dates last',()=>{
 const d=fixture();d.settings.hostSort='created';assert.deepEqual(ids(hostResults(d)),['a','b','c']);d.settings.hostSortDirection='desc';assert.deepEqual(ids(hostResults(d)),['b','a','c']);
 d.settings.hostSort='updated';assert.deepEqual(ids(hostResults(d)),['b','c','a']);d.settings.hostSort='address';assert.deepEqual(ids(hostResults(d)),['a','b','c']);
 d.settings.hostSort='group';d.settings.hostSortDirection='asc';assert.deepEqual(ids(hostResults(d)),['c','a','b']);
 d.settings.hostSort='connected';d.settings.hostSortDirection='desc';d.history=[{hostId:'a',at:'2026-01-01T00:00:00Z'},{hostId:'b',at:'2026-02-01T00:00:00Z'},{hostId:'a',at:'2026-03-01T00:00:00Z'}];assert.deepEqual(ids(hostResults(d)),['a','b','c']);
 assert.deepEqual(d.hosts.map(h=>h.id),['a','b','c']);
});
test('creation-date range is inclusive in local time and excludes unknown dates',()=>{
 const d=fixture();d.hosts[0].createdAt=new Date(2026,0,2,0,0).toISOString();d.hosts[1].createdAt=new Date(2026,0,2,23,59).toISOString();assert.deepEqual(ids(hostResults(d,{from:'2026-01-02',to:'2026-01-02'})),['b','a']);assert.deepEqual(ids(hostResults(d,{from:'2026-01-03',to:'2026-01-02'})),[]);
});
test('creation timestamps are assigned once, preserved on edits, and not fabricated for legacy records',()=>{
 const now='2026-01-01T00:00:00Z',later='2026-02-01T00:00:00Z',created=withMetadata({id:'a',createdAt:'fake'},undefined,now);assert.equal(created.createdAt,now);
 const changed=withMetadata({...created,createdAt:'fake'},created,later);assert.equal(changed.createdAt,now);assert.equal(changed.updatedAt,later);assert.equal(withMetadata({id:'legacy',createdAt:'fake'},{id:'legacy'},now).createdAt,undefined);
 const preview=parseConfig('Host example\n HostName example.test'),imported=applyImport(preview,initialData(),[{id:preview.entries[0].id}]);assert.equal(imported.hosts[0].createdAt,imported.hosts[0].updatedAt);assert(Number.isFinite(Date.parse(imported.hosts[0].createdAt)));
});
