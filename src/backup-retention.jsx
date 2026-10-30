import React,{useEffect,useState} from 'react';
export function BackupRetention({call,state,busy,onChange,onError}) {
 const [count,setCount]=useState(10),[days,setDays]=useState(0),[confirmed,setConfirmed]=useState(false),[saving,setSaving]=useState(false),[message,setMessage]=useState(''),[expanded,setExpanded]=useState(false);
 useEffect(()=>{if(state){setCount(state.policy.maxCount);setDays(state.policy.maxAgeDays);setConfirmed(false)}},[state?.token]);
 if(!state)return null;
 const disabled=busy||saving||!!state.error,changed=count!==state.policy.maxCount||days!==state.policy.maxAgeDays;
 async function save(e){e.preventDefault();setSaving(true);setMessage('');try{await call('vault:saveRetention',{policy:{maxCount:count,maxAgeDays:days},token:state.token,confirm:confirmed});await onChange();setMessage('Saved on this device. Cleanup runs with new backups, on the next unlock and hourly while unlocked.')}catch(e){onError(e.message)}finally{setSaving(false)}}
 return <details className="backup-retention" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}><summary>Automatic cleanup on this device · {state.policy.maxCount} copies{state.policy.maxAgeDays?` · ${state.policy.maxAgeDays} days`:''}</summary>
  <form onSubmit={save}>
   <p>Only regular local recovery copies are cleaned automatically. Keep-marked copies, older import files and shared sync history are excluded. Exports stay under your control.</p>
   <div className="retention-fields"><label className="field"><span>Maximum unmarked copies</span><select aria-label="Maximum unmarked copies" disabled={disabled} value={count} onChange={e=>{setCount(Number(e.target.value));setConfirmed(false);setMessage('')}}>{[5,10,20,50].map(n=><option key={n} value={n}>{n} copies</option>)}</select></label><label className="field"><span>Remove copies older than</span><select aria-label="Remove copies older than" disabled={disabled} value={days} onChange={e=>{setDays(Number(e.target.value));setConfirmed(false);setMessage('')}}><option value={0}>No age limit</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label></div>
   <p>Either limit can trigger cleanup. Harbor always preserves at least three recent unmarked copies whose contents can be verified with the current vault key. Keep-marked copies are extra. If fewer than three can be verified, cleanup waits; unrecognized, unreadable and other-vault copies are left in place. Limits can therefore be exceeded.</p>
   {state.error&&<p role="alert" className="backup-error">{state.error}</p>}
   {state.lastResult?.error&&<p role="alert" className="backup-error">Last cleanup: {state.lastResult.error}</p>}
   {state.lastResult?.skipped&&<p>{state.lastResult.skipped}</p>}
   {changed&&<label className="protection-confirm"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={e=>setConfirmed(e.target.checked)}/>I allow Harbor to automatically delete eligible local copies under these limits.</label>}
   <div className="backup-detail-actions"><button className="button primary" disabled={disabled||!changed||!confirmed}>{saving?'Saving…':'Save cleanup settings'}</button></div>
   {message&&<p role="status">{message}</p>}
  </form>
 </details>
}
