import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createService} from '../app/server.mjs';
import {config,settings} from '../app/config.mjs';
import {bundleFor,signatureFor,run} from '../app/media.mjs';
import {digest} from '../app/returner.mjs';

async function setup(t,mode='speedy_risky',buffer=5,real=false){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelshrink-flow-')),nas=path.join(root,'nas');await fs.mkdir(nas);
  const c=config({WORK_ROOT:path.join(root,'work'),MEDIA_ROOTS:nas,CONFIG_DIR:path.join(root,'config'),MIN_FREE_GB:'0',ENCODE_THREADS:'1'});
  const e=await createService(c,{background:false});e.store.setPaused(true);if(!real)e.engine.scan=async()=>{};
  e.archive.setOptions({mode,buffer,autoSend:false});t.after(async()=>{await e.close();await fs.rm(root,{recursive:true,force:true});});return {...e,root,nas,c};
}
async function settle(e){for(let i=0;i<30;i++){if(e.archive.workerPromise)await e.archive.workerPromise;e.archive.tick();if(!e.archive.active)return;}throw Error('Worker did not settle');}
async function queue(e,n){const paths=[];for(let i=0;i<n;i++){const f=path.join(e.nas,`Film${i}.mp4`);await fs.writeFile(f,'original video bytes');paths.push(f);}const ids=await e.archive.enqueueDownload(paths);await settle(e);return ids;}
async function complete(e,id){
  const r=e.archive.row(id),watch=e.store.watches()[0],bundle=await bundleFor(r.local_source),signature=await signatureFor(r.local_source,bundle);
  const jobId=e.store.enqueue(watch,r.local_source,path.relative(watch.path,r.local_source),signature,bundle,(await fs.stat(r.local_source)).size);
  const output=path.join(e.c.outputRoot,path.basename(path.dirname(r.local_source)),'Result.mkv');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,'new video');
  e.store.updateJob(jobId,{state:'completed',output,output_sha256:await digest(output),output_bytes:9});await e.archive.onCompleted(e.store.job(jobId));return e.archive.row(id);
}
test('risky batches have a hard five-item gate and retain all WORK_OLD until explicit approval',async t=>{
  const e=await setup(t),ids=await queue(e,6),batch=e.archive.batch();assert.equal(batch.ids.length,5);
  assert.equal(e.archive.row(ids[5]).state,'queued_download');
  for(const id of ids.slice(0,5)){const r=await complete(e,id);assert.equal(r.state,'ready');assert.ok(await fs.stat(r.data.workOld));await assert.rejects(fs.stat(r.local_source),{code:'ENOENT'});}
  e.archive.enqueueUpload(ids.slice(0,5),'SEND OG ERSTAT');await settle(e);
  assert.equal(e.archive.row(ids[5]).state,'queued_download');assert.equal(e.archive.status().batch.canApprove,true);
  await assert.rejects(e.archive.remove([ids[0]]),/WORK_OLD/);assert.throws(()=>e.archive.setOptions({mode:'fast'}),/batch/);
  await assert.rejects(e.archive.approveBatch(batch.id,'wrong'),/Bekræft/);assert.equal(e.archive.batch().id,batch.id);
  const old=ids.slice(0,5).map(id=>e.archive.row(id).data.workOld);
  await e.archive.approveBatch(batch.id,'SLET WORK_OLD');await settle(e);
  for(const p of old)await assert.rejects(fs.stat(p),{code:'ENOENT'});
  assert.equal(e.archive.row(ids[5]).state,'local');assert.notEqual(e.archive.batch().id,batch.id);
});
test('smaller batches, cancelled imports and retries cannot silently replenish a batch',async t=>{
  const e=await setup(t,'speedy_risky',1),ids=await queue(e,3),b=e.archive.batch();assert.deepEqual(b.ids,[ids[0]]);
  await e.archive.remove([ids[0]]);e.archive.tick();assert.equal(e.archive.row(ids[1]).state,'queued_download');
  await e.archive.approveBatch(b.id,'SLET WORK_OLD');await settle(e);assert.equal(e.archive.row(ids[1]).state,'local');
  assert.throws(()=>e.archive.setOptions({buffer:6}),/batch/);
});
test('normal modes enforce the buffer and replenish after selected return',async t=>{
  const e=await setup(t,'fast',2),ids=await queue(e,4);assert.equal(e.archive.row(ids[2]).state,'queued_download');
  const r=await complete(e,ids[0]);await assert.rejects(fs.stat(r.local_source),{code:'ENOENT'});assert.equal(r.data.workOld,undefined);
  e.archive.enqueueUpload([r.id],'SEND OG ERSTAT');await settle(e);assert.equal(e.archive.row(ids[2]).state,'local');assert.equal(e.archive.row(ids[3]).state,'queued_download');assert.equal(e.archive.batch(),null);
});
test('risky avoids destination content verification, fast catches corrupt destination copies',async t=>{
  for(const mode of ['speedy_risky','fast'])await t.test(mode,async t=>{
    const e=await setup(t,mode,1),[id]=await queue(e,1),r=await complete(e,id),copy=e.archive.copy.bind(e.archive);
    e.archive.copy=async(...args)=>{const hash=await copy(...args);await fs.writeFile(args[1],'bad video');return hash;};
    e.archive.enqueueUpload([id],'SEND OG ERSTAT');await settle(e);const sent=e.archive.row(id);
    if(mode==='speedy_risky'){assert.equal(sent.state,'sent',sent.data.error);assert.equal(await fs.readFile(r.source.replace('.mp4','.mkv'),'utf8'),'bad video');assert.equal(await fs.readFile(sent.data.workOld,'utf8'),'original video bytes');}
    else {assert.equal(sent.state,'attention');assert.equal(await fs.readFile(r.source,'utf8'),'original video bytes');}
  });
});
test('batch and WORK_OLD survive service restart; no new imports until approval',async t=>{
  const e=await setup(t),ids=await queue(e,6),r=await complete(e,ids[0]),b=e.archive.batch();
  e.archive.enqueueUpload([r.id],'SEND OG ERSTAT');await settle(e);
  const reopened=await createService(e.c,{background:false});
  try{assert.equal(reopened.archive.batch().id,b.id);assert.ok(await fs.stat(reopened.archive.row(r.id).data.workOld));
  reopened.archive.tick();await settle(reopened);assert.equal(reopened.archive.row(ids[5]).state,'queued_download');await assert.rejects(reopened.archive.approveBatch(b.id,'SLET WORK_OLD'),/Send alle/);}finally{await reopened.close();}
});
test('risky resumes a rename interrupted before journal update without rereading destination',async t=>{
  const e=await setup(t,'speedy_risky',1),[id]=await queue(e,1);await complete(e,id);
  const sync=e.archive.sync.bind(e.archive);let once=true;e.archive.sync=async p=>{await sync(p);if(p===e.nas&&once){once=false;throw Error('simulated crash');}};
  e.archive.enqueueUpload([id],'SEND OG ERSTAT');await settle(e);assert.equal(e.archive.row(id).state,'attention');
  e.archive.sync=sync;await e.archive.retry(id);await settle(e);assert.equal(e.archive.row(id).state,'sent',e.archive.row(id).data.error);assert.ok(await fs.stat(e.archive.row(id).data.workOld));
});
test('quick real encoding skips stability delay, records timings and queues chosen automatic returns',async t=>{
  const e=await setup(t,'fast',1,true);e.archive.setOptions({autoSend:true});
  const watch=e.store.watches()[0];e.store.run('UPDATE watches SET settings=? WHERE id=?',JSON.stringify(settings({codec:'h264',onlySmaller:false,preset:'fast'})),watch.id);
  const source=path.join(e.nas,'Actual.mp4');await run(e.c.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1','-threads','1','-c:v','mpeg4','-q:v','2',source]);
  const [id]=await e.archive.enqueueDownload([source]);await settle(e);await e.engine.scan();while(e.engine.scanning)await new Promise(r=>setTimeout(r,5));
  assert.equal(e.store.get("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").n,1,'no 60 second stability wait for completed import');
  e.store.setPaused(false);e.engine.tick();await e.engine.workerPromise;await settle(e);
  const r=e.archive.row(id);assert.equal(r.state,'sent',r.data.error);for(const key of ['downloadMs','encodingMs','checkMs','uploadMs'])assert.equal(typeof r.data.timings[key],'number');
});
test('flow HTTP changes and batch approval require auth/CSRF and explicit risky acknowledgement',async t=>{
  const e=await setup(t,'thorough',1);await new Promise(r=>e.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+e.server.address().port;
  const request=d=>fetch(url+'/api/archive/flow',{method:'PUT',headers:{'Content-Type':'application/json','X-ReelShrink':'1'},body:JSON.stringify(d)});
  let r=await request({mode:'speedy_risky',buffer:5,autoSend:false});assert.equal(r.status,400);
  r=await request({mode:'speedy_risky',buffer:6,autoSend:false,confirmation:'SPEEDY RISKY'});assert.equal(r.status,400);
  r=await request({mode:'speedy_risky',buffer:5,autoSend:false,confirmation:'SPEEDY RISKY'});assert.equal(r.status,200);
  r=await fetch(url+'/api/archive/approve-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
});
test('quick control executes three local decode samples on a longer video',async t=>{
  const e=await setup(t,'fast',1,true),source=path.join(e.nas,'Long.mp4');
  await run(e.c.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=64x48:rate=2:duration=40','-threads','1','-c:v','mpeg4','-q:v','2',source]);
  const watch=e.store.watches()[0];e.store.run('UPDATE watches SET settings=? WHERE id=?',JSON.stringify(settings({codec:'h264',onlySmaller:false,preset:'fast'})),watch.id);
  const log=path.join(e.root,'ffmpeg-args'),wrapper=path.join(e.root,'ffmpeg-wrapper');
  await fs.writeFile(wrapper,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec ffmpeg "$@"\n`,{mode:0o755});e.c.ffmpeg=wrapper;
  const [id]=await e.archive.enqueueDownload([source]);await settle(e);await e.engine.scan();while(e.engine.scanning)await new Promise(r=>setTimeout(r,5));
  e.store.setPaused(false);e.engine.tick();await e.engine.workerPromise;
  const row=e.archive.row(id);assert.equal(row.state,'ready',row.data.error);
  const checks=(await fs.readFile(log,'utf8')).split('\n').filter(l=>l.includes('-f null -'));assert.equal(checks.length,3);assert.ok(checks.every(l=>l.includes('-t 10')&&l.includes(e.c.workRoot)));
});
