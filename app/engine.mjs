import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { inside, filterReason, processingPath, settings } from './config.mjs';
import { discover, bundleFor, signatureFor, assertBundleAllowed, probe, hdrReason, atmosReason, encodeArgs, prepareSubtitles, validateOutput, run } from './media.mjs';
import { fingerprint, digest, sourceHeld } from './returner.mjs';

export class Engine {
  constructor(c, store) {
    this.c=c; this.store=store; this.seen=new Map(); this.scanning=false; this.scanAgain=false;
    this.stopping=false; this.active=null; this.workerPromise=null;
    this.scanController=new AbortController();
  }
  async init() {
    await fs.mkdir(this.c.outputRoot,{recursive:true});
    this.c.outputRoot=await fs.realpath(this.c.outputRoot);
    this.stageRoot=path.join(this.c.outputRoot,'.reelshrink-tmp');
    await fs.mkdir(this.stageRoot,{recursive:true});
    if ((await fs.realpath(this.stageRoot))!==this.stageRoot) throw new Error('Den midlertidige outputmappe må ikke være et symlink.');
    // Recover a crash between atomic directory publication and the final SQLite update.
    for(const row of this.store.all("SELECT * FROM jobs WHERE state!='completed' AND output IS NOT NULL")) {
      try {
        if(!inside(row.output,this.c.outputRoot)) continue;
        const manifest=JSON.parse(await fs.readFile(path.join(path.dirname(row.output),'reelshrink.json'),'utf8'));
        if(manifest.jobId===row.id && (await fs.stat(row.output)).size===row.output_bytes) this.store.updateJob(row.id,{state:'completed',progress:100,error:null});
      } catch(error) {if(!['ENOENT','ENOTDIR'].includes(error.code)) console.error('Output recovery:',row.id,error.message);}
    }
    // Only reclaim staging directories belonging to recorded jobs.
    for(const {id} of this.store.all('SELECT id FROM jobs')) {
      await fs.rm(path.join(this.stageRoot,id),{recursive:true,force:true});
    }
    this.store.run("UPDATE jobs SET state='queued',progress=0,error='Genstartet fra begyndelsen efter afbrydelse.' WHERE state='running'");
    this.store.run("UPDATE jobs SET state='cancelled',error='Annulleret før genstart.' WHERE state='cancel_requested'");
  }
  start() {
    this.scanTimer=setInterval(()=>this.scan(),this.c.scanInterval*1000);
    this.workerTimer=setInterval(()=>this.tick(),1000);
    this.scan(); this.tick();
  }
  async stop() {
    this.stopping=true; clearInterval(this.scanTimer); clearInterval(this.workerTimer);
    this.scanController.abort(); this.active?.controller.abort();
    await this.workerPromise;
    while(this.scanning) await new Promise(r=>setTimeout(r,20));
  }
  async scan() {
    if(this.stopping) return;
    if(this.scanning) {this.scanAgain=true; return;}
    this.scanning=true;
    const live=new Set();
    try {
      for(const watch of this.store.watches().filter(w=>w.enabled)) {
        let waiting=0;
        try {
          processingPath(watch.path,this.c);
          const real=await fs.realpath(watch.path);
          if(real!==watch.path || inside(real,this.c.outputRoot) || inside(this.c.outputRoot,real)) throw new Error('Overvågningsmappen er flyttet eller overlapper output.');
          const videos=await discover(watch.path,this.scanController.signal);
          for(const source of videos) {
            if(this.stopping) break;
            if(sourceHeld(this.store,source)) continue;
            const returned=this.store.get('SELECT stamp FROM returned_files WHERE path=?',source);
            if(returned && returned.stamp===await fingerprint(source)) continue;
            const key=watch.id+'|'+source; live.add(key);
            const bundle=await bundleFor(source), signature=await signatureFor(source,bundle);
            const stat=await fs.stat(source);
            const previous=this.seen.get(key);
            if(!previous || previous.signature!==signature) {
              this.seen.set(key,{signature,since:Date.now()}); waiting++; continue;
            }
            if(!stat.size || Date.now()-previous.since < this.c.stableSeconds*1000) {waiting++;continue;}
            if(this.store.get('SELECT id FROM jobs WHERE watch_id=? AND source=? AND signature=?',watch.id,source,signature)) continue;
            // Superseded queued inputs must not run with an obsolete subtitle set.
            this.store.run("UPDATE jobs SET state='cancelled',error='Kilden blev ændret; en ny version sættes i kø.',updated=? WHERE watch_id=? AND source=? AND state='queued'",Date.now(),watch.id,source);
            // The watch may have been edited or removed during asynchronous discovery.
            const current=this.store.watch(watch.id);
            if(!current?.enabled) break;
            if(sourceHeld(this.store,source)) continue;
            const id=this.store.enqueue(current,source,path.relative(watch.path,source),signature,bundle,stat.size);
            const reason=filterReason(current.settings,stat.size);
            if(id && reason) this.store.updateJob(id,{state:'skipped',error:reason});
          }
          this.store.run('UPDATE watches SET last_scan=?,scan_error=NULL,waiting=? WHERE id=?',Date.now(),waiting,watch.id);
        } catch(error) {
          this.store.run('UPDATE watches SET last_scan=?,scan_error=? WHERE id=?',Date.now(),error.message,watch.id);
        }
      }
      for(const key of this.seen.keys()) if(!live.has(key)) this.seen.delete(key);
    } finally {
      this.scanning=false;
      if(this.scanAgain&&!this.stopping) {this.scanAgain=false;setImmediate(()=>this.scan());}
    }
  }
  tick() {
    if(this.stopping || this.active || this.store.paused()) return;
    const row=this.store.all("SELECT j.id,j.source FROM jobs j JOIN watches w ON w.id=j.watch_id WHERE j.state='queued' AND j.hidden=0 AND w.enabled=1 ORDER BY j.created,j.id").find(j=>!sourceHeld(this.store,j.source));
    if(!row) return;
    const controller=new AbortController();
    this.active={id:row.id,controller};
    this.store.updateJob(row.id,{state:'running',error:null,progress:0,speed:null,eta:null});
    this.workerPromise=this.process(this.store.job(row.id),controller.signal).catch(error=>{
      console.error('Job failed',row.id,error.message);
      this.store.updateJob(row.id,{state:'failed',error:error.message});
    }).finally(()=>{this.active=null;this.workerPromise=null;if(!this.stopping)setImmediate(()=>this.tick());});
  }
  cancel(id) {
    const job=this.store.job(id);
    if(!job) throw new Error('Jobbet findes ikke.');
    if(job.state==='queued') this.store.updateJob(id,{state:'cancelled',error:'Annulleret af bruger.'});
    else if(['running','cancel_requested'].includes(job.state)) {
      this.store.updateJob(id,{state:'cancel_requested'});
      if(this.active?.id===id) this.active.controller.abort();
    } else throw new Error('Kun ventende eller aktive jobs kan annulleres.');
  }
  async retry(id, overrides = {}) {
    const job=this.store.job(id);
    if(!job || !['failed','skipped','cancelled'].includes(job.state)) throw new Error('Dette job kan ikke genstartes.');
    processingPath(job.source,this.c);
    const watch=this.store.watch(job.watch_id);
    if(!watch?.enabled) throw new Error('Aktivér først overvågningsmappen.');
    if(await signatureFor(job.source,await bundleFor(job.source))!==job.signature) throw new Error('Kilden er ændret. Scan mappen for at oprette et nyt job.');
    this.store.updateJob(id,{state:'queued',progress:0,error:null,log:null,speed:null,eta:null,settings:JSON.stringify(settings({...watch.settings,...overrides}))});
    this.tick();
  }
  async process(job,signal) {
    const stage=path.join(this.stageRoot,job.id);
    try {
      const watch=this.store.watch(job.watch_id);
      processingPath(job.source,this.c);
      await assertBundleAllowed(job.source,job.bundle,[watch.path]);
      if(await signatureFor(job.source,await bundleFor(job.source))!==job.signature) throw new Error('Kilden eller dens tilhørende filer er ændret. Scan igen.');
      const sizeReason=filterReason(job.settings,job.input_bytes);
      if(sizeReason) {this.store.updateJob(job.id,{state:'skipped',error:sizeReason});return;}
      const media=await probe(job.source,this.c,signal);
      const info={codec:media.video.codec_name,width:media.video.width,height:media.video.height,duration:media.duration,audio:media.streams.filter(s=>s.codec_type==='audio').length,subtitles:media.streams.filter(s=>s.codec_type==='subtitle').length+job.bundle.subtitles.length};
      this.store.updateJob(job.id,{info:JSON.stringify(info)});
      const reason=filterReason(job.settings,job.input_bytes,media)||hdrReason(media,job.settings)||atmosReason(media,job.settings);
      if(reason) {this.store.updateJob(job.id,{state:'skipped',error:reason});return;}
      const disk=await fs.statfs(this.c.outputRoot);
      if(disk.bavail*disk.bsize < Math.max(this.c.minFreeBytes,job.input_bytes*1.1)) throw new Error('Der er for lidt ledig plads i outputmappen. Frigør plads, og prøv igen.');
      await fs.mkdir(stage,{recursive:false});
      const normalized=path.join(stage,'normalized'), payload=path.join(stage,'payload');
      await fs.mkdir(normalized); await fs.mkdir(payload);
      const sourceStem=path.basename(job.source,path.extname(job.source));
      const encoded=path.join(payload,sourceStem+'.mkv');
      const subtitles=await prepareSubtitles(job.bundle.subtitles,normalized);
      let time=0,speed=0,lastUpdate=0;
      const result=await run(this.c.ffmpeg,encodeArgs(job.source,media,subtitles,encoded,job.settings,this.c),{
        signal,onProgress:(key,value)=>{
          if(key==='out_time_us') time=Math.max(0,Number(value)/1e6)||0;
          if(key==='speed') speed=parseFloat(value)||0;
          if(key==='progress' && Date.now()-lastUpdate>400) {
            lastUpdate=Date.now();
            this.store.updateJob(job.id,{progress:Math.min(99,100*time/media.duration),speed:speed?speed.toFixed(2)+'×':null,eta:speed?Math.max(0,(media.duration-time)/speed):null});
          }
        }
      });
      const outputMedia=await probe(encoded,this.c,signal);
      validateOutput(media,outputMedia,subtitles.length,job.settings);
      // Decode the entire finished video and audio. Container metadata alone cannot prove integrity.
      this.store.updateJob(job.id,{progress:99,speed:null,eta:null});
      await run(this.c.ffmpeg,['-hide_banner','-nostdin','-v','error','-xerror','-threads',String(this.c.threads),'-protocol_whitelist','file,pipe','-i',encoded,'-map','0:v:0','-map','0:a?','-f','null','-'],{signal});
      if(await signatureFor(job.source,await bundleFor(job.source))!==job.signature) throw new Error('Kilden blev ændret under encodingen. Resultatet er kasseret.');
      const size=(await fs.stat(encoded)).size;
      if(job.settings.onlySmaller && size>=job.input_bytes) {
        this.store.updateJob(job.id,{state:'skipped',progress:100,output_bytes:size,error:'Den nye fil blev ikke mindre. Originalen er bevaret, og resultatet er kasseret.',log:result.log});return;
      }
      if(job.settings.copySidecars) {
        const files=[...job.bundle.sidecars,...job.bundle.subtitles.map(s=>s.path)];
        for(const file of files) {
          const dest=path.join(payload,path.relative(path.dirname(job.source),file));
          if(!inside(dest,payload)) throw new Error('Ugyldig tilhørende filsti.');
          await fs.mkdir(path.dirname(dest),{recursive:true});
          await fs.copyFile(file,dest,constants.COPYFILE_EXCL);
        }
      }
      if(signal.aborted) throw new Error('Afbrudt');
      // A unique directory keeps later source revisions and late subtitles from replacing earlier output.
      let finalDir=path.join(this.c.outputRoot,job.watch_id.slice(0,8),path.dirname(job.relative),sourceStem+'--'+job.id.slice(0,8));
      if(this.c.workRoot) {
        const title=path.basename(path.dirname(job.source));
        finalDir=path.join(this.c.outputRoot,title);
        for(let n=2;await fs.stat(finalDir).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});n++)finalDir=path.join(this.c.outputRoot,title+` (${n})`);
      }
      if(!inside(finalDir,this.c.outputRoot)) throw new Error('Ugyldig outputsti.');
      await fs.mkdir(path.dirname(finalDir),{recursive:true});
      if(!inside(await fs.realpath(path.dirname(finalDir)),this.c.outputRoot)) throw new Error('Outputstien peger uden for outputmappen.');
      const output=path.join(finalDir,path.basename(encoded));
      const outputHash=await digest(encoded);
      const manifest={jobId:job.id,source:job.relative,sourceSignature:job.signature,outputSha256:outputHash,settings:job.settings,inputBytes:job.input_bytes,outputBytes:size,completedAt:new Date().toISOString()};
      await fs.writeFile(path.join(payload,'reelshrink.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
      // Record the destination before rename so recovery can recognize an already-published result.
      this.store.updateJob(job.id,{output,output_sha256:outputHash,output_bytes:size,saved_bytes:Math.max(0,job.input_bytes-size),log:result.log});
      try {await fs.access(finalDir);throw new Error('Outputmappen findes allerede; den overskrives ikke.');} catch(e) {if(e.code!=='ENOENT')throw e;}
      await fs.rename(payload,finalDir);
      this.store.updateJob(job.id,{state:'completed',progress:100,speed:null,eta:null,error:null});
      await this.work?.onCompleted(this.store.job(job.id));
    } catch(error) {
      const state=signal.aborted?(this.stopping?'queued':'cancelled'):'failed';
      this.store.updateJob(job.id,{state,error:signal.aborted?(this.stopping?'Fortsætter fra begyndelsen efter genstart.':'Annulleret af bruger.'):error.message,log:error.log||null,speed:null,eta:null});
    } finally {
      await fs.rm(stage,{recursive:true,force:true});
    }
  }
}
