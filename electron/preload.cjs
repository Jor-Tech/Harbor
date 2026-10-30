const {contextBridge,ipcRenderer,webUtils} = require('electron');
const events = new Set(['updates:changed','mcp:changed','terminal:data','terminal:status','vault:locked','vault:changed','vault:syncStatus','forward:status','auth:prompt','auth:dismiss','auth:failure','transfer:status']);
contextBridge.exposeInMainWorld('harbor',{
  platform: process.platform,
  filePaths:files=>Array.from(files).map(file=>webUtils.getPathForFile(file)).filter(Boolean),
  invoke:async (action,args) => { const r = await ipcRenderer.invoke('harbor',action,args); if (!r.ok) throw new Error(r.error); return r.data; },
  on:(event,listener) => { if (!events.has(event)) throw new Error('Unsupported event'); const fn=(_event,data)=>listener(data); ipcRenderer.on(event,fn); return ()=>ipcRenderer.removeListener(event,fn); }
});
