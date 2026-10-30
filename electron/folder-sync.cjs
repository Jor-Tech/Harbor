'use strict';
// One scheduler per device. It never resolves conflicts or works while locked.
// Polling catches atomic replacements from sync providers on every desktop OS.
class FolderSync {
 constructor({sync,emit=()=>{},intervalMs=30000,debounceMs=2000}){
  this.sync=sync;this.emit=emit;this.intervalMs=intervalMs;this.debounceMs=debounceMs;
  this.enabled=false;this.unlocked=false;this.generation=0;this.state={phase:'off',enabled:false};this.busy=null;
 }
 publish(extra){this.state={...this.state,enabled:this.enabled,...extra};this.emit(this.state);return this.state}
 configure({enabled=this.enabled,unlocked=this.unlocked}={}){
  ++this.generation;clearTimeout(this.timer);clearInterval(this.poll);this.timer=null;this.poll=null;
  this.enabled=enabled;this.unlocked=unlocked;this.blocked=false;this.dirty=false;
  this.publish({phase:!enabled?'off':!unlocked?'locked':'idle',error:undefined});
  if(enabled&&unlocked){this.poll=setInterval(()=>this.schedule(0),this.intervalMs);this.schedule(this.debounceMs)}
 }
 schedule(delay=this.debounceMs){
  if(!this.enabled||!this.unlocked||this.blocked)return;
  if(this.busy){this.dirty=true;return;}
  clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;void this.run()},delay);
 }
 async run(manual=false){
  if(!this.unlocked)throw new Error('Unlock the vault before syncing.');
  if(this.busy)return this.busy;
  if(!manual&&(!this.enabled||this.blocked))return;
  clearTimeout(this.timer);this.timer=null;const generation=this.generation;this.dirty=false;
  this.publish({phase:'syncing',error:undefined});
  const operation=Promise.resolve().then(()=>{
   if(generation!==this.generation)throw new Error('Sync settings changed; try again.');return this.sync();
  });
  this.busy=operation;
  try{
   const result=await operation;
   if(generation!==this.generation)return result;
   this.blocked=result.result.status==='conflict';
   this.publish({phase:this.blocked?'conflict':this.enabled?'idle':'off',lastResult:result.result.status,lastSyncedAt:new Date().toISOString(),error:undefined});
   return result;
  }catch(error){
   if(generation===this.generation){this.blocked=true;this.publish({phase:'error',error:error.message});}
   if(manual)throw error;
  }finally{
   if(this.busy===operation)this.busy=null;
   if(generation===this.generation&&this.dirty&&!this.blocked)this.schedule();
   // configure() may have run during the old operation. Its pending change
   // must still get a turn after the old operation releases the single slot.
   if(generation!==this.generation&&this.enabled&&this.unlocked&&!this.blocked)this.schedule();
  }
 }
 resume(result){this.blocked=false;this.publish({...(result?{lastResult:result.status,lastSyncedAt:new Date().toISOString()}:{}),phase:this.enabled?(this.unlocked?'idle':'locked'):'off',error:undefined});this.schedule()}
 close(){this.configure({enabled:false,unlocked:false})}
}
module.exports={FolderSync};
