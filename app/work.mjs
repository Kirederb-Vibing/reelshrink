import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Archive } from './archive.mjs';
import { inside } from './config.mjs';
import { bundleFor, signatureFor, discover } from './media.mjs';
import { digest, fingerprint } from './returner.mjs';

const exists = p => fs.lstat(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const fail = message => {throw new Error(message);};
export function readableName(name) {
  return name.normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g,' ').replace(/\s+/g,' ').replace(/^\.+|[. ]+$/g,'').trim().slice(0,110) || 'Video';
}

// One lifecycle for local and network sources. Legacy transfer journals remain
// readable, but new transfers never create OLD files or use the old returner.
export class WorkArchive extends Archive {
  constructor(...args) {
    super(...args);
    // Serialize filesystem edits with workers and discovery, including the
    // asynchronous validation phase before the first write.
    for(const method of ['enqueueDownload','remove','rename','receive','rescanWork','setDestination']) {
      const operation=this[method].bind(this);
      this[method]=async(...values)=>{
        if(this.editing)fail('En anden Work-handling er i gang.');
        this.editing=true;
        try{return await operation(...values);}finally{this.editing=false;this.tick();}
      };
    }
  }
  tick() {if(!this.editing)super.tick();}
  async init() {
    await super.init();
    if(!this.c.workRoot)return;
    this.engine.work=this;
    this.store.archiveHeld=file=>Boolean(this.editing)||!this.list().some(r=>r.local_source===file&&r.state==='local');
    this.store.run("UPDATE archive_items SET state='failed_download' WHERE state='receiving'");
    for(const r of this.list()) {
      if(r.state==='local'&&!this.store.get('SELECT id FROM returns WHERE original=?',r.local_source)) {
        try {await this.finish(r);} catch(e){this.update(r.id,'local',{...r.data,error:e.message});}
      } else if(r.state==='local'&&this.store.get('SELECT id FROM returns WHERE original=?',r.local_source)) {
        this.update(r.id,'local',{...r.data,error:'Dette emne har historik fra det tidligere OLD-forløb. Gennemgå lokale filer før fjernelse og ny import.'});
      }
    }
  }
  completed(r) {return this.store.get("SELECT * FROM jobs WHERE source=? AND state='completed' AND output IS NOT NULL ORDER BY updated DESC LIMIT 1",r.local_source);}
  status() {
    return {enabled:Boolean(this.c.workRoot),workRoot:this.c.workRoot,drives:this.c.archiveDrives,active:this.active,items:this.list().map(r=>({...r,canSend:r.state==='ready'&&!r.data.browserOnly,canDownload:['ready','sent'].includes(r.state),canUnsafeSend:false}))};
  }
  async reserveName(source,reserved=[]) {
    const stem=readableName(path.basename(source,path.extname(source)));
    for(let n=1;;n++) {
      const name=stem+(n===1?'':` (${n})`),dir=path.join(this.c.mediaRoots[0],name);
      if(!reserved.includes(dir)&&!this.list().some(r=>path.dirname(r.local_source)===dir)&&!await exists(dir))return dir;
    }
  }
  async enqueueDownload(paths) {
    if(this.active)fail('Vent til den aktive overførsel er færdig.');
    // Reserve descriptive directories before the base worker starts.
    const oldTick=this.tick;this.tick=()=>{};
    let ids;
    try {
      ids=await super.enqueueDownload(paths);
      for(const id of ids) {
        const r=this.row(id),dir=await this.reserveName(r.source);
        this.store.run('UPDATE archive_items SET local_source=? WHERE id=?',path.join(dir,path.basename(r.source)),id);
      }
    } finally {this.tick=oldTick;}
    this.tick();return ids;
  }
  async finish(r,verifiedStamp=null) {
    const job=this.completed(r);if(!job)return;
    await this.allowed(job.output,this.c.outputRoot);
    const resultStamp=await fingerprint(job.output);
    if(!job.output_sha256||(verifiedStamp!==resultStamp&&await digest(job.output)!==job.output_sha256))fail('Resultatet er ændret siden encodingkontrollen. Work-originalen bevares.');
    await this.sync(job.output);await this.sync(path.dirname(job.output));
    if(await exists(r.local_source)) {
      await this.allowed(r.local_source,this.c.mediaRoots[0]);
      if(await signatureFor(r.local_source,await bundleFor(r.local_source))!==job.signature)fail('Work-originalen er ændret. Den slettes ikke.');
      // Persist the verified output before deleting the disposable work original.
      this.update(r.id,'local',{...r.data,result:job.output,resultHash:job.output_sha256,phase:'Kontrolleret – frigør Work-original'});
      await fs.unlink(r.local_source);await this.sync(path.dirname(r.local_source));
    }
    this.update(r.id,'ready',{...this.row(r.id).data,result:job.output,resultHash:job.output_sha256,resultStamp,phase:r.data.browserOnly?'Klar til download':'Klar til tilbageførsel',error:null});
  }
  async onCompleted(job) {
    const r=this.list().find(r=>r.local_source===job.source&&r.state==='local');
    if(r)try {await this.finish(r,job.verifiedStamp);}catch(e){this.update(r.id,'local',{...this.row(r.id).data,error:e.message});}
  }
  enqueueUpload(ids,confirmation) {
    if(this.editing)fail('En Work-handling er i gang.');
    this.enabled();this.ids(ids);
    if(confirmation!=='SEND OG ERSTAT')fail('Bekræft med SEND OG ERSTAT.');
    const rows=ids.map(id=>this.row(id));
    if(rows.some(r=>!r||r.state!=='ready'||r.data.browserOnly))fail('Vælg kun kontrollerede resultater med en destination.');
    for(const r of rows)this.update(r.id,'queued_upload',{...r.data,phase:'I kø til tilbageførsel',bytes:0,error:null,upload:null});
    this.tick();
  }
  async upload(r) {
    if(r.data.upload&&!r.data.upload.workV2)fail('En tidligere overførsel kræver manuel gennemgang. Dens journal er bevaret.');
    await this.origin(r);
    const d=r.data;
    if(!d.upload) {
      await this.allowed(d.result,this.c.outputRoot);
      if(d.resultStamp){await this.unchanged(d.result,d.resultStamp,this.c.outputRoot);}else if(await digest(d.result)!==d.resultHash)fail('Resultatet er ændret siden encodingkontrollen.');
      const target=path.join(d.originalDir,path.basename(r.source,path.extname(r.source))+path.extname(d.result));
      if(target!==r.source&&await exists(target))fail('Der findes allerede en anden fil på resultatets destinationssti.');
      if(d.browserOnly)fail('Vælg en destination først.');
      if(d.browserUpload) {if(await exists(r.source))fail('Destinationen findes allerede.');}
      else await this.checkOriginal(r);
      const size=(await fs.stat(d.result)).size;
      const disk=await fs.statfs(d.originalDir);
      if(disk.bavail*disk.bsize<size+this.c.minFreeBytes)fail('For lidt plads på destinationsdrevet.');
      const temp=path.join(d.originalDir,'.reelshrink-new-'+r.id);
      if(await exists(temp))fail('En tidligere midlertidig fil kræver gennemgang.');
      d.upload={workV2:true,phase:'copying',files:[{local:d.result,target,temp,size,hash:d.resultHash,stamp:await fingerprint(d.result)}]};
      d.bytes=0;d.total=size;this.update(r.id,'uploading',d);
    }
    const j=d.upload,f=j.files[0];
    if(j.phase==='copying') {
      await this.unchanged(f.local,f.stamp,this.c.outputRoot);
      if(await exists(f.temp)){await this.allowed(f.temp,d.originalDir);await fs.unlink(f.temp);}
      d.bytes=0;d.phase='Sender til oprindelig placering';this.update(r.id,'uploading',d);
      if(await this.copy(f.local,f.temp,r,'uploading')!==f.hash||await digest(f.temp)!==f.hash)fail('Checksumkontrollen fejlede. Originalen er bevaret.');
      f.tempStamp=await fingerprint(f.temp);j.phase='installing';this.update(r.id,'uploading',d);
    }
    if(j.phase==='installing') {
      // Recovery after publication must still finish removing a differently named
      // original. No deletion is attempted before the new file is durable.
      const installed=!await exists(f.temp)&&await exists(f.target)&&await digest(f.target)===f.hash;
      if(!installed) {
        await this.unchanged(f.temp,f.tempStamp,d.originalDir);
        if(d.browserUpload) {if(await exists(r.source))fail('Destinationen er oprettet siden upload.');}
        else await this.checkOriginal(r,d.flowMode!=='fast');
        if(f.target===r.source)await fs.rename(f.temp,f.target);
        else {await fs.link(f.temp,f.target);await fs.unlink(f.temp);}
        await this.sync(d.originalDir);
      }
      await this.allowed(f.target,d.originalDir);
      await this.unchanged(f.target,f.tempStamp,d.originalDir);
      if(f.target!==r.source&&!d.browserUpload&&await exists(r.source)) {
        await this.checkOriginal(r);
        await fs.unlink(r.source);await this.sync(d.originalDir);
      }
      if(await exists(f.temp)){await this.allowed(f.temp,d.originalDir);if(await digest(f.temp)===f.hash)await fs.unlink(f.temp);}
      f.tempStamp=await fingerprint(f.target);j.phase='done';this.update(r.id,'uploading',d);
    }
    this.update(r.id,'sent',{...d,phase:'Tilbageført og kontrolleret',bytes:d.total,speed:0,error:null});
  }
  async checkOriginal(r,verifyHash=false) {
    const f=r.data.manifest.find(f=>f.source===r.source);
    if(!f?.hash)fail('Originalens checksum mangler. Hent emnet igen.');
    await this.unchanged(r.source,f.stamp,r.data.originalDir);
    if(verifyHash&&await digest(r.source)!==f.hash)fail('Originalen er ændret siden import. Den erstattes ikke.');
  }
  async cancelDownloads() {
    for(const r of this.list().filter(r=>r.state==='queued_download'))this.update(r.id,'failed_download',{...r.data,phase:'Hentning stoppet',error:'Annulleret af bruger.'});
    if(this.active&&this.row(this.active)?.state==='downloading') {
      this.controller.abort();await this.workerPromise;this.controller=new AbortController();
    }
  }
  async remove(ids) {
    this.ids(ids);
    if(this.active||this.engine.active||this.engine.scanning)fail('Stop overførslen, og vent til aktiv encoding/scanning er færdig.');
    const rows=ids.map(id=>this.row(id));
    if(rows.some(r=>!r||['uploading','attention'].includes(r.state)))fail('En uafsluttet tilbageførsel skal gennemgås først.');
    // Validate the complete removal scope before deleting anything.
    const dirs=[];
    for(const r of rows) {
      const dir=path.dirname(r.local_source);
      if(path.dirname(dir)!==this.c.mediaRoots[0]||this.list().some(other=>other.id!==r.id&&inside(other.local_source,dir)))fail('Ugyldig eller delt Work-mappe.');
      if(await exists(dir)){await this.allowed(dir,this.c.mediaRoots[0],true);dirs.push(dir);}
      for(const job of this.store.all('SELECT output FROM jobs WHERE source=? AND output IS NOT NULL',r.local_source)) {
        const outputDir=path.dirname(job.output);
        if(outputDir===this.c.outputRoot)fail('Ugyldig resultatmappe.');
        if(await exists(outputDir)){await this.allowed(outputDir,this.c.outputRoot,true);dirs.push(outputDir);}
      }
      if(r.data.result) {
        const resultDir=path.dirname(r.data.result);
        if(resultDir===this.c.outputRoot)fail('Ugyldig resultatmappe.');
        if(await exists(resultDir)){await this.allowed(resultDir,this.c.outputRoot,true);dirs.push(resultDir);}
      }
      const stage=path.join(this.c.workRoot,'.archive-'+r.id);
      if(await exists(stage)){await this.allowed(stage,this.c.workRoot,true);dirs.push(stage);}
    }
    this.active='removing';
    try {
      for(const dir of new Set(dirs))await fs.rm(dir,{recursive:true,force:true});
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        for(const r of rows) {
          this.store.run('DELETE FROM jobs WHERE source=?',r.local_source);
          this.store.run('DELETE FROM returned_files WHERE path=?',r.local_source);
          this.store.run('DELETE FROM returns WHERE original=?',r.local_source);
          this.store.run('DELETE FROM archive_items WHERE id=?',r.id);
        }
        this.store.db.exec('COMMIT');
      }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    }finally{this.active=null;}
  }
  async cleanup(ids,confirmation) {if(confirmation!=='SLET LOKAL')fail('Bekræft med SLET LOKAL.');return this.remove(ids);}
  async rename(id,title) {
    const r=this.row(id);
    if(!r||r.state!=='local'||this.active||this.engine.active||this.engine.scanning||this.completed(r))fail('Omdøb før encoding starter; sæt encodingkøen på pause først.');
    if(typeof title!=='string'||!title.trim())fail('Angiv en titel.');
    const oldDir=path.dirname(r.local_source),dir=path.join(this.c.mediaRoots[0],readableName(title));
    if(dir===oldDir)return;
    await this.allowed(oldDir,this.c.mediaRoots[0],true);
    if(await exists(dir)||this.list().some(x=>path.dirname(x.local_source)===dir))fail('Titlen bruges allerede.');
    this.active='renaming';
    try {
      await fs.rename(oldDir,dir);
      try {
        this.store.db.exec('BEGIN IMMEDIATE');
        this.store.run('DELETE FROM jobs WHERE source=?',r.local_source);
        this.store.run('UPDATE archive_items SET local_source=? WHERE id=?',path.join(dir,path.basename(r.local_source)),id);
        this.store.db.exec('COMMIT');
      }catch(e){this.store.db.exec('ROLLBACK');await fs.rename(dir,oldDir);throw e;}
    }finally{this.active=null;}
  }
  async jobOverrides(id,overrides) {
    const job=this.store.job(id);
    if(!job||!['queued','skipped','failed','cancelled'].includes(job.state))fail('Indstillinger kan kun ændres før encoding.');
    if(Object.keys(overrides).some(k=>!['allowHDR','allowAtmosLoss'].includes(k))||Object.values(overrides).some(v=>typeof v!=='boolean'))fail('Ugyldigt override.');
    this.store.updateJob(id,{settings:JSON.stringify({...job.settings,...overrides})});
  }
  async receive(req,name,destination='') {
    this.enabled();
    if(this.active)fail('Vent til den aktive overførsel er færdig.');
    if(!name||path.basename(name)!==name||!['.mkv','.mp4','.avi','.mov','.m4v','.ts','.m2ts','.webm'].includes(path.extname(name).toLowerCase()))fail('Vælg en enkelt videofil.');
    const size=Number(req.headers['content-length']);
    if(!Number.isSafeInteger(size)||size<=0)fail('Upload kræver en kendt filstørrelse.');
    const disk=await fs.statfs(this.c.workRoot);
    if(disk.bavail*disk.bsize<size*2.2+this.c.minFreeBytes)fail('For lidt plads til upload og encoding.');
    const id=randomUUID(),dir=await this.reserveName(name),local=path.join(dir,name),stage=path.join(this.c.workRoot,'.archive-'+id);
    let source='browser:'+id+'/'+name,data={browserUpload:true,browserOnly:!destination,manifest:[],originalDir:'',drive:{type:'local'},phase:'Uploader fra browser',bytes:0,total:size,error:null};
    if(destination) {
      const drive=this.drive(destination);await this.allowed(destination,drive.path,true);
      source=path.join(destination,name);if(await exists(source)||await exists(path.join(destination,path.basename(name,path.extname(name))+'.mkv')))fail('Destinationen indeholder allerede denne fil.');
      data={...data,drive,originalDir:destination,directoryId:await this.identity(destination),driveId:await this.identity(drive.path)};
    }
    this.store.run('INSERT INTO archive_items VALUES (?,?,?,?,?,?)',id,source,local,'receiving',JSON.stringify(data),Date.now());
    this.active=id;
    const task=(async()=>{
      await fs.mkdir(stage);
      let bytes=0,last=0;
      const meter=new Transform({transform:(chunk,encoding,done)=>{bytes+=chunk.length;if(bytes>size)return done(new Error('Upload er større end angivet.'));if(Date.now()-last>300){last=Date.now();data.bytes=bytes;this.update(id,'receiving',data);}done(null,chunk);}});
      await pipeline(req,meter,createWriteStream(path.join(stage,name),{flags:'wx'}),{signal:this.controller.signal});
      if(bytes!==size)fail('Upload blev afbrudt.');
      await this.sync(path.join(stage,name));await this.sync(stage);await fs.rename(stage,dir);await this.sync(this.c.mediaRoots[0]);
      this.update(id,'local',{...data,bytes:size,phase:'Uploadet – klar til encoding'});
      return id;
    })();
    this.workerPromise=task;
    try{return await task;}catch(e){this.update(id,'failed_download',{...data,error:e.message,phase:'Upload afbrudt'});throw e;}finally{this.active=null;this.workerPromise=null;}
  }
  async rescanWork() {
    if(this.active||this.engine.active||this.engine.scanning)fail('Vent til det aktive arbejde er færdigt.');
    // Discover manually copied files without guessing their original destination.
    for(const file of await discover(this.c.mediaRoots[0])) {
      if(this.list().some(r=>r.local_source===file))continue;
      // Every discovered video gets its own directory; removing one item must
      // never delete a different episode that shared the incoming directory.
      const dir=await this.reserveName(file);await fs.mkdir(dir);
      const local=path.join(dir,path.basename(file)),bundle=await bundleFor(file);
      for(const sidecar of new Set([...bundle.sidecars,...bundle.subtitles.map(s=>s.path)])) {
        await this.allowed(sidecar,this.c.mediaRoots[0]);
        const dest=path.join(dir,path.relative(path.dirname(file),sidecar));
        if(!inside(dest,dir))fail('Ugyldig sidefil.');
        await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(sidecar,dest,1);
      }
      await fs.rename(file,local);
      this.store.run("DELETE FROM jobs WHERE source=? AND state!='completed'",file);
      const id=randomUUID();
      this.store.run('INSERT INTO archive_items VALUES (?,?,?,?,?,?)',id,'browser:'+id+'/'+path.basename(file),local,'local',JSON.stringify({browserUpload:true,browserOnly:true,manifest:[],drive:{type:'local'},originalDir:'',phase:'Fundet i Work – destination kan vælges',bytes:0,total:0}),Date.now());
    }
    for(const r of this.list().filter(r=>r.state==='local')) {
      await this.finish(r);
      this.store.run("DELETE FROM jobs WHERE source=? AND (hidden=1 OR state IN ('cancelled','skipped','failed'))",r.local_source);
    }
    this.engine.scan();
  }
  async setDestination(id,destination) {
    const r=this.row(id);if(!r||!r.data.browserUpload||!['local','ready'].includes(r.state)||this.active)fail('Kun browserfiler uden aktiv overførsel kan få en destination.');
    const drive=this.drive(destination);await this.allowed(destination,drive.path,true);
    const source=path.join(destination,path.basename(r.local_source));
    if(await exists(source)||await exists(path.join(destination,path.basename(source,path.extname(source))+'.mkv')))fail('Der findes allerede en fil på destinationen.');
    this.store.run('UPDATE archive_items SET source=? WHERE id=?',source,id);
    this.update(id,r.state,{...r.data,browserOnly:false,drive,originalDir:destination,directoryId:await this.identity(destination),driveId:await this.identity(drive.path)});
  }
  async retry(id) {
    const r=this.row(id);
    if(r?.data.browserUpload&&r.state==='failed_download')fail('Fjern den afbrudte upload og vælg filen igen.');
    return super.retry(id);
  }
}
