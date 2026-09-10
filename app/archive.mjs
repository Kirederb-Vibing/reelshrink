import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { inside, settings } from './config.mjs';
import { bundleFor } from './media.mjs';
import { digest, fingerprint } from './returner.mjs';

const extensions = new Set(['.mkv','.mp4','.m4v','.avi','.mov','.ts','.m2ts','.webm']);
const exists = async p => { try { await fs.lstat(p); return true; } catch(e) { if(e.code==='ENOENT') return false; throw e; } };
const filesIn = (source,bundle) => [...new Set([source,...bundle.sidecars,...bundle.subtitles.map(s=>s.path)])];
const conflict = message => { throw new Error(message); };

// A declared drive type is descriptive. Identity checks also detect a vanished mount
// being replaced by an empty host directory. No library is polled by this worker.
export class Archive {
  constructor(c,store,engine,returner) {
    Object.assign(this,{c,store,engine,returner,active:null,stopping:false});
    this.controller=new AbortController();
  }
  async init() {
    if(!this.c.workRoot) return;
    for(const dir of [this.c.workRoot,...this.c.mediaRoots,...this.c.returnInputRoots,this.c.outputRoot]) {
      await fs.mkdir(dir,{recursive:true});
      if(await fs.realpath(dir)!==dir) conflict('Arbejdsarkivet må ikke indeholde symlinks.');
      const type=Number((await fs.statfs(dir)).type)>>>0;
      if([0x6969,0xff534d42,0xfe534d42].includes(type)) conflict('Arbejdsarkivet er på NFS/SMB. Vælg en lokal disk.');
    }
    for(const drive of this.c.archiveDrives) {
      if(await fs.realpath(drive.path)!==drive.path) conflict('Biblioteksdrevet må ikke være et symlink: '+drive.path);
    }
    for(const watch of this.store.watches()) if(!inside(watch.path,this.c.mediaRoots[0])) {
      this.store.run('UPDATE watches SET enabled=0,scan_error=? WHERE id=?','Arbejdsarkiv aktiveret. Hent filer i Arbejdsarkiv-fanen.',watch.id);
      this.store.run("UPDATE jobs SET state='cancelled',error='Tidligere direkte bibliotekskø stoppet ved aktivering af arbejdsarkiv.' WHERE watch_id=? AND state IN ('queued','running','cancel_requested')",watch.id);
    }
    if(!this.store.watches().some(w=>w.path===this.c.mediaRoots[0])) this.store.addWatch('Arbejdsarkiv',this.c.mediaRoots[0],settings());
    const opts=this.returner.options();
    if((opts.from&&!inside(opts.from,this.c.workRoot))||(opts.to&&!inside(opts.to,this.c.mediaRoots[0]))) this.store.run("INSERT OR REPLACE INTO settings VALUES ('return_options',?)",JSON.stringify({automatic:false,from:'',to:''}));
    this.store.archiveHeld=file=>this.list().some(r=>!['local','failed_download','queued_download','downloading'].includes(r.state)&&inside(file,path.dirname(r.local_source)));
    this.store.run("UPDATE archive_items SET state='failed_download' WHERE state='downloading'");
    this.store.run("UPDATE archive_items SET state='attention' WHERE state='uploading'");
  }
  enabled() { if(!this.c.workRoot) conflict('Aktivér arbejdsarkivet med WORK_ROOT. Se docs/work-archive.md.'); }
  row(id) { const r=this.store.get('SELECT * FROM archive_items WHERE id=?',id);return r?{...r,data:JSON.parse(r.data)}:null; }
  list() { return this.store.all('SELECT id FROM archive_items ORDER BY updated DESC,id').map(r=>this.row(r.id)); }
  update(id,state,data) { this.store.run('UPDATE archive_items SET state=?,data=?,updated=? WHERE id=?',state,JSON.stringify(data),Date.now(),id); }
  result(r) {
    const row=this.store.get("SELECT * FROM returns WHERE original=? AND mode='reelshrink' AND state='deleted' ORDER BY updated DESC LIMIT 1",r.local_source);
    return row?{...row,details:JSON.parse(row.details)}:null;
  }
  status() { return {enabled:Boolean(this.c.workRoot),workRoot:this.c.workRoot,drives:this.c.archiveDrives,active:this.active,items:this.list().map(r=>({...r,canSend:r.state==='local'&&Boolean(this.result(r))}))}; }
  ids(ids) { if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(s=>typeof s!=='string')) conflict('Vælg 1–100 forskellige emner.'); }
  drive(file) { return this.c.archiveDrives.find(d=>inside(file,d.path))||conflict('Stien ligger uden for biblioteksdrevene.'); }
  async allowed(file,root,directory=false) {
    if(!path.isAbsolute(file)||!inside(file,root)||await fs.realpath(file)!==path.resolve(file)) conflict('Stien er ændret, et symlink eller uden for drevet: '+file);
    const stat=await fs.lstat(file);
    if(directory?!stat.isDirectory():!stat.isFile()) conflict('Forkert filtype: '+file);
    return stat;
  }
  async identity(dir) { const s=await fs.stat(dir,{bigint:true});return [s.dev,s.ino].join(':'); }
  async sync(file) { const h=await fs.open(file,'r');try{await h.sync();}finally{await h.close();} }
  async browse(directory) {
    this.enabled();
    if(!directory) return {path:null,parent:null,entries:this.c.archiveDrives.map(d=>({...d,directory:true}))};
    directory=path.resolve(directory);const drive=this.drive(directory);
    await this.allowed(directory,drive.path,true);
    const entries=[];
    for(const e of await fs.readdir(directory,{withFileTypes:true})) {
      if(e.name.startsWith('.')||e.isSymbolicLink()) continue;
      if(!e.isDirectory()&&!(e.isFile()&&extensions.has(path.extname(e.name).toLowerCase()))) continue;
      const file=path.join(directory,e.name);
      entries.push({name:e.name,path:file,directory:e.isDirectory(),type:drive.type,size:e.isFile()?(await fs.stat(file)).size:null,imported:Boolean(this.store.get('SELECT id FROM archive_items WHERE source=?',file))});
    }
    return {path:directory,parent:directory===drive.path?null:path.dirname(directory),entries:entries.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name))};
  }
  async enqueueDownload(paths) {
    this.enabled();this.ids(paths);
    const rows=[];
    for(const source of paths) {
      const drive=this.drive(source);await this.allowed(source,drive.path);
      if(!extensions.has(path.extname(source).toLowerCase())) conflict('Vælg en film eller et afsnit.');
      if(this.store.get('SELECT id FROM archive_items WHERE source=?',source)) conflict('Emnet findes allerede i arbejdsarkivets historik. Brug Prøv igen ved fejl.');
      const id=randomUUID(),local_source=path.join(this.c.mediaRoots[0],id,path.basename(source));
      const originalDir=path.dirname(source),manifest=[];
      for(const file of filesIn(source,await bundleFor(source))) {
        const s=await this.allowed(file,originalDir);
        manifest.push({source:file,relative:path.relative(originalDir,file),stamp:await fingerprint(file),size:s.size});
      }
      rows.push({id,source,local_source,data:{drive,originalDir,directoryId:await this.identity(originalDir),driveId:await this.identity(drive.path),manifest,phase:'I kø til hentning',bytes:0,total:manifest.reduce((n,f)=>n+f.size,0),error:null}});
    }
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for(const r of rows) this.store.run('INSERT INTO archive_items VALUES (?,?,?,?,?,?)',r.id,r.source,r.local_source,'queued_download',JSON.stringify(r.data),Date.now());
      this.store.db.exec('COMMIT');
    } catch(e){this.store.db.exec('ROLLBACK');throw e;}
    this.tick();return rows.map(r=>r.id);
  }
  enqueueUpload(ids,confirmation) {
    this.enabled();this.ids(ids);
    if(confirmation!=='SEND OG ERSTAT') conflict('Bekræft med SEND OG ERSTAT.');
    const rows=ids.map(id=>this.row(id));
    if(rows.some(r=>!r||r.state!=='local'||!this.result(r))) conflict('Gennemfør lokal tilbageflytning og godkend først resultatet ved at slette OLD i OLD-køen.');
    if(this.returner.active||this.returner.scanning||this.engine.active) conflict('Vent til igangværende encoding eller tilbageflytning er afsluttet.');
    for(const r of rows) this.update(r.id,'queued_upload',{...r.data,phase:'Valgt til afsendelse',bytes:0,error:null});
    this.tick();
  }
  retry(id) {
    const r=this.row(id);if(!r||!['failed_download','attention'].includes(r.state)) conflict('Kun afbrudte eller fejlede overførsler kan genstartes.');
    this.update(id,r.state==='failed_download'?'queued_download':'queued_upload',{...r.data,error:null});this.tick();
  }
  async cleanup(ids,confirmation) {
    this.enabled();this.ids(ids);
    if(confirmation!=='SLET LOKAL') conflict('Bekræft med SLET LOKAL.');
    if(this.active||this.engine.active||this.returner.active||this.returner.scanning) conflict('Vent til igangværende arbejde er afsluttet.');
    const rows=ids.map(id=>this.row(id));
    if(rows.some(r=>!r||r.state!=='sent')) conflict('Kun afsendte og verificerede emner kan ryddes lokalt.');
    this.active='cleanup';
    this.workerPromise=(async()=>{
      for(const r of rows) {
        await this.origin(r);
        // Revalidate the server copy before removing the remaining local fallback.
        for(const f of r.data.upload.files) {await this.unchanged(f.target,f.tempStamp,r.data.originalDir);if(await digest(f.target)!==f.hash) conflict('Serverkopien er ændret. Lokal oprydning stoppet.');}
        const dir=path.dirname(r.local_source);
        if(path.dirname(dir)!==this.c.mediaRoots[0]||path.basename(dir)!==r.id) conflict('Ugyldig lokal emnemappe.');
        if(await exists(dir)){await this.allowed(dir,this.c.mediaRoots[0],true);await fs.rm(dir,{recursive:true});}
        for(const job of this.store.all('SELECT output FROM jobs WHERE source=? AND output IS NOT NULL',r.local_source)) {
          const outputDir=path.dirname(job.output);
          if(await exists(outputDir)){await this.allowed(outputDir,this.c.outputRoot,true);if(outputDir===this.c.outputRoot)conflict('Ugyldig outputmappe.');await fs.rm(outputDir,{recursive:true});}
        }
        this.update(r.id,'cleaned',{...r.data,phase:'Afsendt – lokal plads frigivet',error:null});
      }
    })();
    try{await this.workerPromise;}finally{this.active=null;this.workerPromise=null;}
  }
  start() { if(this.c.workRoot){this.timer=setInterval(()=>this.tick(),1000);this.tick();} }
  async stop() { this.stopping=true;clearInterval(this.timer);this.controller.abort();await this.workerPromise; }
  tick() {
    if(!this.c.workRoot||this.active||this.stopping) return;
    const r=this.list().reverse().find(r=>['queued_download','queued_upload'].includes(r.state));if(!r)return;
    this.active=r.id;
    this.workerPromise=(r.state==='queued_download'?this.download(r):this.upload(r)).catch(e=>{
      const latest=this.row(r.id);this.update(r.id,r.state==='queued_download'?'failed_download':'attention',{...latest.data,error:e.message,phase:'Stoppet – gennemgå og prøv igen'});
    }).finally(()=>{this.active=null;this.workerPromise=null;});
  }
  async origin(r) {
    const d=r.data;
    this.drive(r.source);
    await this.allowed(d.originalDir,d.drive.path,true);
    if(await this.identity(d.drive.path)!==d.driveId||await this.identity(d.originalDir)!==d.directoryId) conflict('Biblioteksdrevet eller originalmappen er udskiftet eller ikke monteret.');
  }
  async unchanged(file,stamp,root) { await this.allowed(file,root);if(await fingerprint(file)!==stamp) conflict('Filen er ændret siden hentning/kontrol: '+file); }
  async copy(source,dest,r,state) {
    const hash=createHash('sha256');let last=0;const started=Date.now(),base=r.data.bytes;
    const meter=new Transform({transform:(chunk,encoding,done)=>{
      hash.update(chunk);r.data.bytes+=chunk.length;
      if(Date.now()-last>250){last=Date.now();r.data.speed=(r.data.bytes-base)/Math.max(.001,(Date.now()-started)/1000);this.update(r.id,state,r.data);}
      done(null,chunk);
    }});
    await pipeline(createReadStream(source,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}),meter,createWriteStream(dest,{flags:'wx'}),{signal:this.controller.signal});
    await this.sync(dest);this.update(r.id,state,r.data);return hash.digest('hex');
  }
  async download(r) {
    await this.origin(r);
    const finalDir=path.dirname(r.local_source),stage=path.join(this.c.workRoot,'.archive-'+r.id);
    if(await exists(finalDir)) {
      await this.allowed(finalDir,this.c.mediaRoots[0],true);
      for(const f of r.data.manifest) if(!f.hash||await digest(path.join(finalDir,f.relative))!==f.hash) conflict('En tidligere hentning findes med ændret indhold. Ingen lokale filer overskrives.');
      this.update(r.id,'local',{...r.data,phase:'Hentet – klar til lokal encoding',error:null});return;
    }
    if(await exists(stage)){await this.allowed(stage,this.c.workRoot,true);await fs.rm(stage,{recursive:true});}
    const disk=await fs.statfs(this.c.workRoot);
    if(disk.bavail*disk.bsize<r.data.total*2.2+this.c.minFreeBytes) conflict('For lidt lokal plads til original, encoding og sikker tilbageflytning.');
    await fs.mkdir(stage);
    r.data.bytes=0;r.data.phase='Henter fra bibliotek';this.update(r.id,'downloading',r.data);
    for(const f of r.data.manifest) {
      await this.unchanged(f.source,f.stamp,r.data.originalDir);
      const dest=path.join(stage,f.relative);await fs.mkdir(path.dirname(dest),{recursive:true});
      f.hash=await this.copy(f.source,dest,r,'downloading');
      await this.unchanged(f.source,f.stamp,r.data.originalDir);
      r.data.phase='Kontrollerer lokal kopi';this.update(r.id,'downloading',r.data);
      if(await digest(dest)!==f.hash) conflict('Checksumfejl ved hentning.');
      r.data.phase='Henter fra bibliotek';
    }
    await this.origin(r);
    for(const f of r.data.manifest) await this.unchanged(f.source,f.stamp,r.data.originalDir);
    this.update(r.id,'downloading',r.data);await this.sync(stage);
    await fs.rename(stage,finalDir);await this.sync(this.c.mediaRoots[0]);
    this.update(r.id,'local',{...r.data,phase:'Hentet – klar til lokal encoding',error:null,speed:0});this.engine.scan();
  }
  async upload(r) {
    await this.origin(r);
    const d=r.data,localDir=path.dirname(r.local_source);
    const resuming=Boolean(d.upload);
    await this.allowed(localDir,this.c.mediaRoots[0],true);
    const result=this.result(r);if(!result) conflict('Godkend den lokale erstatning i OLD-køen før afsendelse.');
    if(this.engine.active||this.returner.active||this.returner.scanning) conflict('Lokal behandling er aktiv. Prøv igen når den er færdig.');
    if(!d.upload) {
      await this.unchanged(result.details.target,result.details.targetStamp,localDir);
      if(await digest(result.details.target)!==result.details.hash) conflict('Den godkendte lokale video er ændret.');
      const all=filesIn(result.details.target,await bundleFor(result.details.target));
      // Retain every imported subtitle/metadata file even when encoding copySidecars=false.
      for(const f of d.manifest) if(f.source!==r.source) all.push(path.join(localDir,f.relative));
      const files=[];
      for(const file of new Set(all)) {
        const s=await this.allowed(file,localDir),relative=path.relative(localDir,file);
        const target=path.join(d.originalDir,relative);await this.allowed(path.dirname(target),d.originalDir,true);
        const hash=await digest(file),original=d.manifest.find(f=>f.source===target);
        // Shared posters/subtitles with unchanged content need no network round trip.
        if(file!==result.details.target&&original?.hash===hash) continue;
        files.push({local:file,target,size:s.size,stamp:await fingerprint(file),hash});
      }
      for(const f of d.manifest) await this.unchanged(f.source,f.stamp,d.originalDir);
      for(const f of files) if(!d.manifest.some(old=>old.source===f.target)&&await exists(f.target)) conflict('En ny destinationsfil findes allerede: '+f.target);
      const disk=await fs.statfs(d.originalDir),total=files.reduce((n,f)=>n+f.size,0);
      if(disk.bavail*disk.bsize<total+this.c.minFreeBytes) conflict('For lidt plads på destinationsdrevet.');
      const removals=d.manifest.filter(f=>f.source===r.source||files.some(n=>n.target===f.source));
      d.upload={dir:path.join(d.originalDir,'.reelshrink-archive-'+r.id),files,removals,phase:'copying'};
      d.bytes=0;d.total=total;this.update(r.id,'uploading',d);
    }
    const j=d.upload;await fs.mkdir(j.dir,{recursive:true});await this.allowed(j.dir,d.originalDir,true);
    if(j.phase==='copying') {
      d.bytes=0;
      for(const [i,f] of j.files.entries()) {
        const temp=path.join(j.dir,'new-'+i);f.temp=temp;
        await this.unchanged(f.local,f.stamp,localDir);
        if(await exists(temp)) {await this.allowed(temp,j.dir);await fs.unlink(temp);}
        d.phase='Sender til server';this.update(r.id,'uploading',d);
        if(await this.copy(f.local,temp,r,'uploading')!==f.hash) conflict('Den lokale fil ændrede indhold under overførsel.');
        d.phase='Kontrollerer kopi på server';this.update(r.id,'uploading',d);
        if(await digest(temp)!==f.hash) conflict('Checksumfejl på destinationsdrevet.');
        await this.unchanged(f.local,f.stamp,localDir);
        f.tempStamp=await fingerprint(temp);
      }
      // Test exclusive publication support before moving any original.
      const test=path.join(j.dir,'link-test');
      if(await exists(test))await fs.unlink(test);
      await fs.link(j.files[0].temp,test);await fs.unlink(test);await this.sync(j.dir);
      await this.origin(r);
      for(const f of d.manifest) await this.unchanged(f.source,f.stamp,d.originalDir);
      j.phase='installing';d.phase='Installerer verificerede filer';this.update(r.id,'uploading',d);
    }
    if(j.phase==='installing') {
      if(resuming) for(const f of j.files) {await this.unchanged(f.temp,f.tempStamp,j.dir);if(await digest(f.temp)!==f.hash) conflict('En midlertidig serverfil er ændret. Originalerne bevares.');}
      // The complete intent was persisted before any rename. Re-entry recognizes
      // moved originals and published hardlinks by their saved inode/size/mtime.
      for(const [i,f] of j.removals.entries()) {
        const backup=path.join(j.dir,'old-'+i);
        if(await exists(backup)) await this.unchanged(backup,f.stamp,j.dir);
        else {await this.unchanged(f.source,f.stamp,d.originalDir);await fs.rename(f.source,backup);await this.sync(path.dirname(f.source));await this.sync(j.dir);}
      }
      for(const f of j.files) {
        await this.unchanged(f.temp,f.tempStamp,j.dir);
        await this.allowed(path.dirname(f.target),d.originalDir,true);
        if(await exists(f.target)) await this.unchanged(f.target,f.tempStamp,d.originalDir);
        else {await fs.link(f.temp,f.target);await this.sync(path.dirname(f.target));}
      }
      // Installed targets are hardlinks to the already hashed staging files.
      for(const f of j.files) await this.unchanged(f.target,f.tempStamp,d.originalDir);
      j.phase='cleanup';d.phase='Fjerner registrerede originaler';this.update(r.id,'uploading',d);
    }
    // Never recursively delete a library folder. Only this item's manifest is owned.
    for(const f of j.files) await this.unchanged(f.target,f.tempStamp,d.originalDir);
    if(resuming) for(const f of j.files) if(await digest(f.target)!==f.hash) conflict('Serverkopien er ændret. Oprindelige sikkerhedskopier bevares.');
    for(const [i,f] of j.removals.entries()) {
      const backup=path.join(j.dir,'old-'+i);
      if(await exists(backup)){await this.unchanged(backup,f.stamp,j.dir);await fs.unlink(backup);}
    }
    for(const f of j.files) if(await exists(f.temp)){await this.unchanged(f.temp,f.tempStamp,j.dir);await fs.unlink(f.temp);}
    await this.sync(j.dir);await fs.rmdir(j.dir);await this.sync(d.originalDir);
    this.update(r.id,'sent',{...d,phase:'Sendt og verificeret – lokal kopi bevaret',bytes:d.total,speed:0,error:null});
  }
}
