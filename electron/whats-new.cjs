'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const semver=require('semver');
const releaseNotes=require('./release-notes.json');

// Local to this installation, deliberately separate from synced vault settings.
class WhatsNew {
 constructor({dir,version,packaged,notes=releaseNotes}) {
  this.file=path.join(dir,'whats-new.json');this.version=version;this.packaged=packaged;
  this.notes=notes.filter(note=>semver.lte(note.version,version)).sort((a,b)=>semver.rcompare(a.version,b.version));
  this.preferences={automatic:true,seenVersion:version};this.error='';
 }
 async load() {
  try {
   const saved=JSON.parse(await fs.readFile(this.file,'utf8'));
   if(typeof saved.automatic!=='boolean'||!semver.valid(saved.seenVersion))throw new Error('Invalid preferences');
   this.preferences={automatic:saved.automatic,seenVersion:saved.seenVersion};
  } catch(error) {
   // First use establishes a baseline: neither a fresh install nor upgrading
   // from a build without this feature should replay historical announcements.
   if(error.code==='ENOENT'&&this.packaged){try{await this.persist(this.preferences)}catch{this.error='Could not save What’s new preferences.'}}
   else if(error.code!=='ENOENT')this.error='Could not read What’s new preferences.';
  }
  return this.snapshot();
 }
 snapshot() {
  const pending=this.notes.filter(note=>semver.gt(note.version,this.preferences.seenVersion));
  return {version:this.version,automatic:this.preferences.automatic,releases:this.notes,pending,
   autoShow:this.packaged&&!this.error&&this.preferences.automatic&&pending.some(note=>note.meaningful),error:this.error};
 }
 async persist(next) {
  const temp=this.file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,JSON.stringify(next),{mode:0o600});await fs.rename(temp,this.file);this.preferences=next;this.error=''}finally{await fs.rm(temp,{force:true})}
 }
 async configure(args) {
  if(!args||Object.keys(args).length!==1||typeof args.automatic!=='boolean')throw new Error('Invalid What’s new preference.');
  await this.persist({...this.preferences,automatic:args.automatic});return this.snapshot();
 }
 async acknowledge() {
  // A downgrade must never move the watermark backwards.
  const seenVersion=semver.gt(this.version,this.preferences.seenVersion)?this.version:this.preferences.seenVersion;
  await this.persist({...this.preferences,seenVersion});return this.snapshot();
 }
}
module.exports={WhatsNew};
