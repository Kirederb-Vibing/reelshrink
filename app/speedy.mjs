import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkArchive } from './work.mjs';
import { bundleFor, signatureFor } from './media.mjs';
import { digest, fingerprint } from './returner.mjs';

const exists=p=>fs.lstat(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const fail=message=>{throw new Error(message);};
export const FLOW_DEFAULTS=Object.freeze({mode:'thorough',buffer:3,autoSend:false});
export class FlowArchive extends WorkArchive {
  options() {return {...FLOW_DEFAULTS,...JSON.parse(this.store.get("SELECT value FROM settings WHERE key='work_flow'")?.value||'{}')};}
  batch() {return JSON.parse(this.store.get("SELECT value FROM settings WHERE key='work_batch'")?.value||'null');}
  saveBatch(b) {this.store.run("INSERT OR REPLACE INTO settings VALUES ('work_batch',?)",JSON.stringify(b));}
  setOptions(input) {
    if(this.active||this.editing||this.engine.active)fail('Vent til den aktive operation er færdig.');
    if(this.batch())fail('Godkend den aktive batch før ændring af tilstand eller batchstørrelse.');
    const o={...this.options(),...input};
    if(!['thorough','fast','speedy_risky'].includes(o.mode)||!Number.isInteger(o.buffer)||o.buffer<1||o.buffer>5||typeof o.autoSend!=='boolean')fail('Vælg en kontroltilstand og 1–5 film.');
    if(o.mode!==this.options().mode&&this.list().some(r=>!['queued_download','failed_download','sent','cleaned'].includes(r.state)))fail('Afslut eller fjern aktuelle Work-emner før skift af kontroltilstand.');
    this.store.run("INSERT OR REPLACE INTO settings VALUES ('work_flow',?)",JSON.stringify(o));this.tick();return o;
  }
  status() {
    const s=super.status(),batch=this.batch();
    return {...s,flow:this.options(),batch:batch?{...batch,items:batch.ids.map(id=>this.row(id)).filter(Boolean),canApprove:!this.active&&!this.editing&&!this.engine.active&&batch.ids.every(id=>!this.row(id)||this.row(id).state==='sent')}:null};
  }
  entry(source){return this.list().find(r=>r.local_source===source);}
  quickCheck(source){return ['fast','speedy_risky'].includes(this.entry(source)?.data.flowMode);}
  trustedImport(source,signature){return this.entry(source)?.data.localSignature===signature;}
  recordTiming(source,key,ms){const r=this.entry(source);if(r)this.update(r.id,r.state,{...r.data,timings:{...r.data.timings,[key]:ms}});}
  async init(){await super.init();}
  async enqueueDownload(paths){
    const ids=await super.enqueueDownload(paths);
    let order=this.list().reduce((n,r)=>Math.max(n,r.data.queueOrder||0),Date.now()*1000);
    for(const id of ids){const r=this.row(id);this.update(id,r.state,{...r.data,queueOrder:++order});}
    return ids;
  }
  tick() {
    if(!this.c.workRoot||this.editing||this.active||this.stopping)return;
    const o=this.options();let rows=this.list().sort((a,b)=>(a.data.queueOrder||a.updated*1000)-(b.data.queueOrder||b.updated*1000)),batch=this.batch();
    // Returning a selected item has priority over prefetching another source.
    let r=rows.find(r=>r.state==='queued_upload');
    if(!r) {
      if(o.mode==='speedy_risky') {
        if(!batch){const ids=rows.filter(r=>r.state==='queued_download').slice(0,o.buffer).map(r=>r.id);if(!ids.length)return;batch={id:randomUUID(),ids,limit:o.buffer};this.saveBatch(batch);}
        r=rows.find(r=>r.state==='queued_download'&&batch.ids.includes(r.id));
      }else {
        const occupied=rows.filter(r=>['local','ready','downloading','receiving','queued_upload','uploading','attention'].includes(r.state)).length;
        if(occupied<o.buffer)r=rows.find(r=>r.state==='queued_download');
      }
    }
    if(!r)return;
    if(r.state==='queued_download'){
      this.update(r.id,r.state,{...r.data,flowMode:o.mode,...(batch?{batchId:batch.id}:{})});r=this.row(r.id);
    }
    this.active=r.id;const downloading=r.state==='queued_download',started=Date.now();
    this.workerPromise=(downloading?this.download(r):this.upload(r)).catch(e=>{const latest=this.row(r.id);this.update(r.id,downloading?'failed_download':'attention',{...latest.data,error:e.message,phase:'Stoppet – gennemgå og prøv igen'});}).finally(()=>{
      this.recordTiming(r.local_source,downloading?'downloadMs':'uploadMs',Date.now()-started);this.active=null;this.workerPromise=null;
      if(!this.stopping)setImmediate(()=>this.tick());
    });
  }
  async download(r) {
    // Fast imports calculate a hash as bytes arrive, without a second full read.
    r.data.quickImport=['fast','speedy_risky'].includes(r.data.flowMode);
    await super.download(r);
    const row=this.row(r.id);
    if(row.state==='local'){
      const localSignature=await signatureFor(row.local_source,await bundleFor(row.local_source));
      this.update(r.id,'local',{...row.data,localSignature});this.engine.scan();
    }
  }
  async finish(r,verifiedStamp=null) {
    if(r.data.flowMode!=='speedy_risky'){
      await super.finish(r,verifiedStamp);
      const row=this.row(r.id);
      if(row.state==='ready'&&this.options().autoSend&&!row.data.browserOnly)this.update(r.id,'queued_upload',{...row.data,phase:'I kø til automatisk afsendelse',upload:null});
      return;
    }
    const job=this.completed(r);if(!job)return;
    await this.allowed(job.output,this.c.outputRoot);
    if(!job.output_sha256||(verifiedStamp!==await fingerprint(job.output)&&await digest(job.output)!==job.output_sha256))fail('Work-resultatet er ændret. Originalen bevares.');
    await this.sync(job.output);await this.sync(path.dirname(job.output));
    const old=r.data.workOld||r.local_source+'.WORK_OLD';
    if(await exists(r.local_source)){
      await this.allowed(r.local_source,this.c.mediaRoots[0]);
      if(await signatureFor(r.local_source,await bundleFor(r.local_source))!==job.signature)fail('Work-originalen er ændret.');
      if(await exists(old))fail('WORK_OLD findes allerede.');
      this.update(r.id,'local',{...r.data,workOld:old,result:job.output,resultHash:job.output_sha256});
      await fs.rename(r.local_source,old);await this.sync(path.dirname(old));
    }
    await this.allowed(old,this.c.mediaRoots[0]);
    this.update(r.id,'ready',{...this.row(r.id).data,workOld:old,oldStamp:await fingerprint(old),result:job.output,resultHash:job.output_sha256,resultStamp:await fingerprint(job.output),phase:'SPEEDY RISKY – klar; WORK_OLD bevaret',error:null});
    if(this.options().autoSend&&!r.data.browserOnly){const row=this.row(r.id);this.update(r.id,'queued_upload',{...row.data,phase:'SPEEDY RISKY – i kø til automatisk afsendelse',upload:null});}
  }
  async upload(r) {
    if(r.data.flowMode!=='speedy_risky')return super.upload(r);
    const d=r.data;
    await this.origin(r); // Path/mount boundaries remain mandatory; no NAS content reads.
    await this.unchanged(d.workOld,d.oldStamp,this.c.mediaRoots[0]);
    await this.unchanged(d.result,d.resultStamp,this.c.outputRoot);
    if(!d.upload){
      const target=path.join(d.originalDir,path.basename(r.source,path.extname(r.source))+path.extname(d.result)),temp=path.join(d.originalDir,'.reelshrink-speedy-'+r.id);
      if(target!==r.source&&await exists(target))fail('En anden fil findes på destinationsstien.');
      if(await exists(temp))fail('En tidligere midlertidig fil kræver gennemgang.');
      const size=(await fs.stat(d.result)).size,disk=await fs.statfs(d.originalDir);
      if(disk.bavail*disk.bsize<size+this.c.minFreeBytes)fail('For lidt plads på destinationen.');
      d.upload={speedy:true,phase:'copying',target,temp};d.bytes=0;d.total=size;this.update(r.id,'uploading',d);
    }
    const j=d.upload;if(!j.speedy)fail('Forkert overførselsjournal.');
    if(j.phase==='copying'){
      if(await exists(j.temp)){await this.allowed(j.temp,d.originalDir);await fs.unlink(j.temp);}
      d.bytes=0;d.phase='SPEEDY RISKY – sender uden NAS-indholdskontrol';this.update(r.id,'uploading',d);
      // The hash here is computed on the local read stream, not by rereading NAS.
      if(await this.copy(d.result,j.temp,r,'uploading')!==d.resultHash)fail('Work-resultatet ændrede indhold under læsning. WORK_OLD bevares.');
      j.tempStamp=await fingerprint(j.temp);j.phase='installing';this.update(r.id,'uploading',d);
    }
    if(j.phase==='installing'){
      if(await exists(j.temp)){
        await this.unchanged(j.temp,j.tempStamp,d.originalDir);
        if(j.target===r.source){if(await exists(r.source))await this.allowed(r.source,d.originalDir);await fs.rename(j.temp,j.target);}
        else if(await exists(j.target)){
          // Only our exact published inode may be resumed without content reads.
          const a=await fs.stat(j.temp),b=await this.allowed(j.target,d.originalDir);
          if(a.ino!==b.ino||a.dev!==b.dev)fail('Destinationskonflikt. WORK_OLD bevares.');
          await fs.unlink(j.temp);
        }else{await fs.link(j.temp,j.target);await fs.unlink(j.temp);}
        await this.sync(d.originalDir);
      }else{
        // A renamed/linked file keeps its fingerprint; unknown files stop recovery.
        await this.unchanged(j.target,j.tempStamp,d.originalDir);
      }
      j.phase='installed';this.update(r.id,'uploading',d);
    }
    if(j.phase==='installed'){
      await this.unchanged(j.target,j.tempStamp,d.originalDir);
      if(j.target!==r.source&&await exists(r.source)){await this.allowed(r.source,d.originalDir);await fs.unlink(r.source);await this.sync(d.originalDir);}
      j.phase='done';this.update(r.id,'uploading',d);
    }
    this.update(r.id,'sent',{...d,phase:'Afventer godkendelse: slet WORK_OLD',bytes:d.total,speed:0,error:null});
  }
  async approveBatch(batchId,confirmation) {
    if(confirmation!=='SLET WORK_OLD')fail('Bekræft med SLET WORK_OLD.');
    if(this.active||this.editing||this.engine.active||this.engine.scanning)fail('Vent til aktive operationer er færdige.');
    const b=this.batch();if(!b||b.id!==batchId)fail('Batchen er ændret. Opdatér siden.');
    const rows=b.ids.map(id=>this.row(id)).filter(Boolean);
    if(rows.some(r=>r.state!=='sent'))fail('Send alle færdige resultater, og fjern eventuelle ubehandlede/fejlede emner før godkendelse.');
    this.editing=true;
    try{
      for(const r of rows){
        const old=r.data.workOld;
        if(old!==r.local_source+'.WORK_OLD')fail('Ugyldig WORK_OLD-sti.');
        if(await exists(old))await this.unchanged(old,r.data.oldStamp,this.c.mediaRoots[0]);
        await this.unchanged(r.data.result,r.data.resultStamp,this.c.outputRoot);
      }
      for(const r of rows){
        if(await exists(r.data.workOld)){await fs.unlink(r.data.workOld);await this.sync(path.dirname(r.data.workOld));}
        this.update(r.id,'sent',{...r.data,oldApproved:true,phase:'WORK_OLD slettet efter din godkendelse'});
      }
      this.saveBatch(null);
    }finally{this.editing=false;this.tick();}
  }
  async remove(ids) {
    if(ids.some(id=>{const r=this.row(id);return r?.data.workOld&&!r.data.oldApproved;}))fail('WORK_OLD kan kun slettes med batchens godkendelsesknap.');
    return super.remove(ids);
  }
  async retry(id){
    const r=this.row(id);
    if(r?.state==='local'&&this.completed(r)){
      if(this.editing||this.active||this.engine.active)fail('Vent til aktiv behandling er færdig.');
      this.editing=true;try{await this.finish(r);}finally{this.editing=false;this.tick();}return;
    }
    return super.retry(id);
  }
  async receive(...args) {
    if(this.options().mode==='speedy_risky')fail('SPEEDY RISKY bruger valgte biblioteksfiler. Brug Hurtig/Grundig til browserupload.');
    if(this.list().filter(r=>['local','ready','downloading','receiving','attention','queued_upload'].includes(r.state)).length>=this.options().buffer)fail('Work-bufferen er fuld. Send eller fjern et emne først.');
    const id=await super.receive(...args),r=this.row(id);this.update(id,r.state,{...r.data,flowMode:this.options().mode,localSignature:await signatureFor(r.local_source,await bundleFor(r.local_source))});return id;
  }
  async rescanWork(){if(this.options().mode==='speedy_risky')fail('Genfinding er slået fra under SPEEDY RISKY. Brug retry for batchens jobs.');return super.rescanWork();}
}
