import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createService } from '../app/server.mjs';
import { config,settings } from '../app/config.mjs';
import { digest } from '../app/returner.mjs';
import { bundleFor,signatureFor,run,hdrReason,atmosReason } from '../app/media.mjs';

async function setup(t,type='network') {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'work-v2-')),nas=path.join(root,'nas');await fs.mkdir(nas);
  const c=config({WORK_ROOT:path.join(root,'work'),MEDIA_ROOTS:nas,MEDIA_DRIVE_TYPES:type,CONFIG_DIR:path.join(root,'config'),MIN_FREE_GB:'0',ENCODE_THREADS:'1'});c.stableSeconds=.001;
  const e=await createService(c,{background:false});
  t.after(async()=>{await e.close();await fs.rm(root,{recursive:true,force:true});});
  e.store.setPaused(true);
  return {...e,c,nas,root};
}
async function drain(e) {while(e.archive.active||e.archive.list().some(r=>['queued_upload','queued_download'].includes(r.state))){await e.archive.workerPromise;e.archive.tick();}}
async function importFile(e,name='Film.2026.mp4') {
  const source=path.join(e.nas,name);await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,'original video');
  const [id]=await e.archive.enqueueDownload([source]);await drain(e);return e.archive.row(id);
}
async function completed(e,r) {
  const bundle=await bundleFor(r.local_source),signature=await signatureFor(r.local_source,bundle);
  const size=(await fs.stat(r.local_source)).size;
  const watch=e.store.watches()[0],id=e.store.get('SELECT id FROM jobs WHERE source=? AND signature=?',r.local_source,signature)?.id||e.store.enqueue(watch,r.local_source,path.relative(watch.path,r.local_source),signature,bundle,size);
  const output=path.join(e.c.outputRoot,path.basename(path.dirname(r.local_source)),'Film.mkv');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,'encoded');
  e.store.updateJob(id,{state:'completed',output,output_sha256:await digest(output),output_bytes:7});return e.store.job(id);
}
test('one lifecycle for both network and local drives, no OLD and selected send only',async t=>{
  for(const type of ['network','local'])await t.test(type,async t=>{
    const e=await setup(t,type),r=await importFile(e),other=await importFile(e,'Other.mp4');
    assert.equal(path.basename(path.dirname(r.local_source)),'Film.2026');
    await fs.writeFile(path.join(e.nas,'poster.jpg'),'poster');
    const job=await completed(e,r);await e.archive.onCompleted(job);
    assert.equal(e.archive.row(r.id).state,'ready');await assert.rejects(fs.stat(r.local_source),{code:'ENOENT'});
    assert.equal(await fs.readFile(r.source,'utf8'),'original video');
    e.archive.enqueueUpload([r.id],'SEND OG ERSTAT');await drain(e);
    assert.equal(e.archive.row(r.id).state,'sent',e.archive.row(r.id).data.error);
    assert.equal(await fs.readFile(r.source.replace('.mp4','.mkv'),'utf8'),'encoded');
    await assert.rejects(fs.stat(r.source),{code:'ENOENT'});
    assert.equal(await fs.readFile(other.source,'utf8'),'original video');
    assert.equal(await fs.readFile(path.join(e.nas,'poster.jpg'),'utf8'),'poster');
    assert.equal((await fs.readdir(e.nas)).some(n=>/OLD|reelshrink/.test(n)),false);
  });
});
test('changed output preserves Work original; changed NAS original blocks replacement',async t=>{
  const e=await setup(t),r=await importFile(e),job=await completed(e,r);
  await fs.writeFile(job.output,'tampered');await e.archive.onCompleted(job);
  assert.equal(e.archive.row(r.id).state,'local');assert.ok(await fs.stat(r.local_source));
  await fs.writeFile(job.output,'encoded');await e.archive.onCompleted(job);
  await fs.writeFile(r.source,'changed on NAS');e.archive.enqueueUpload([r.id],'SEND OG ERSTAT');await drain(e);
  assert.equal(e.archive.row(r.id).state,'attention');assert.equal(await fs.readFile(r.source,'utf8'),'changed on NAS');
});
test('crash after publication resumes deletion and no overwrite of conflicting destination',async t=>{
  const e=await setup(t),r=await importFile(e);await e.archive.onCompleted(await completed(e,r));
  const sync=e.archive.sync.bind(e.archive);let interrupted=false;
  e.archive.sync=async file=>{await sync(file);if(file===e.nas&&!interrupted){interrupted=true;throw new Error('simulated power failure');}};
  e.archive.enqueueUpload([r.id],'SEND OG ERSTAT');await drain(e);
  assert.equal(e.archive.row(r.id).state,'attention');assert.ok(await fs.stat(r.source));
  e.archive.sync=sync;await e.archive.retry(r.id);await drain(e);
  assert.equal(e.archive.row(r.id).state,'sent');await assert.rejects(fs.stat(r.source),{code:'ENOENT'});
  const second=await importFile(e,'Another.mp4');await e.archive.onCompleted(await completed(e,second));await fs.writeFile(second.source.replace('.mp4','.mkv'),'unrelated');
  e.archive.enqueueUpload([second.id],'SEND OG ERSTAT');await drain(e);assert.equal(e.archive.row(second.id).state,'attention');assert.equal(await fs.readFile(second.source.replace('.mp4','.mkv'),'utf8'),'unrelated');assert.ok(await fs.stat(second.source));
});
test('same-extension replacement is recoverable and leaves no OLD',async t=>{
  const e=await setup(t),r=await importFile(e,'Film.mkv');await e.archive.onCompleted(await completed(e,r));
  e.archive.enqueueUpload([r.id],'SEND OG ERSTAT');await drain(e);assert.equal(e.archive.row(r.id).state,'sent');assert.equal(await fs.readFile(r.source,'utf8'),'encoded');
});
test('stop import queue, remove and reimport without stale history',async t=>{
  const e=await setup(t);const tick=e.archive.tick.bind(e.archive);e.archive.tick=()=>{};
  const source=path.join(e.nas,'Queued.mp4');await fs.writeFile(source,'video');const [id]=await e.archive.enqueueDownload([source]);
  await e.archive.cancelDownloads();assert.equal(e.archive.row(id).state,'failed_download');
  await e.archive.remove([id]);assert.equal(e.archive.row(id),null);e.archive.tick=tick;
  const [again]=await e.archive.enqueueDownload([source]);await drain(e);assert.equal(e.archive.row(again).state,'local');
});
test('rename, rescan cancelled jobs, remove work without touching NAS',async t=>{
  const e=await setup(t),r=await importFile(e);
  while(e.engine.scanning)await new Promise(resolve=>setTimeout(resolve,5));
  await e.archive.rename(r.id,'A descriptive title');const next=e.archive.row(r.id);assert.match(next.local_source,/A descriptive title/);
  await e.engine.scan();await new Promise(resolve=>setTimeout(resolve,5));await e.engine.scan();
  const job=e.store.get('SELECT id FROM jobs WHERE source=?',next.local_source);assert.ok(job);e.store.updateJob(job.id,{state:'cancelled'});
  await e.archive.rescanWork();while(e.engine.scanning)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(e.store.get("SELECT COUNT(*) AS n FROM jobs WHERE source=? AND state='cancelled'",next.local_source).n,0);
  await e.archive.remove([r.id]);await assert.rejects(fs.stat(next.local_source),{code:'ENOENT'});assert.ok(await fs.stat(r.source));
});
test('stream browser upload and destination selection; interrupted upload stays isolated',async t=>{
  const e=await setup(t),req=Readable.from([Buffer.from('browser video')]);req.headers={'content-length':'13'};
  const id=await e.archive.receive(req,'Browser.mp4');let r=e.archive.row(id);assert.equal(r.state,'local');assert.equal(r.data.browserOnly,true);
  await e.archive.setDestination(id,e.nas);r=e.archive.row(id);assert.equal(r.source,path.join(e.nas,'Browser.mp4'));
  await e.archive.onCompleted(await completed(e,r));e.archive.enqueueUpload([id],'SEND OG ERSTAT');await drain(e);assert.equal(e.archive.row(id).state,'sent',e.archive.row(id).data.error);
  const broken=Readable.from([Buffer.from('short')]);broken.headers={'content-length':'20'};await assert.rejects(e.archive.receive(broken,'Broken.mp4'),/afbrudt/);
  assert.equal(e.archive.list().find(r=>r.local_source.endsWith('Broken.mp4')).state,'failed_download');
  const invalid=Readable.from([]);invalid.headers={'content-length':'1'};await assert.rejects(e.archive.receive(invalid,'../escape.mp4'),/videofil/);
});
test('HDR and Atmos overrides are independent, validated, and interlaced remains protected',()=>{
  const media={video:{color_transfer:'smpte2084',field_order:'progressive'},streams:[{codec_type:'audio',codec_name:'truehd'}]};
  assert.match(hdrReason(media,settings()),/HDR/);assert.equal(hdrReason(media,settings({allowHDR:true})),null);
  assert.equal(atmosReason(media,settings()),null);assert.match(atmosReason(media,settings({audio:'aac_stereo'})),/Atmos/);
  assert.equal(atmosReason(media,settings({audio:'aac_stereo',allowAtmosLoss:true})),null);
  assert.throws(()=>settings({allowHDR:'yes'}));media.video.field_order='tt';assert.match(hdrReason(media,{allowHDR:true}),/Interlaced/);
});
test('real encoding validates and automatically prepares return with readable output path',async t=>{
  const e=await setup(t),source=path.join(e.nas,'Actual.2026.mp4');
  await run(e.c.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1','-threads','1','-c:v','mpeg4','-q:v','2',source]);
  const originalHash=await digest(source),[id]=await e.archive.enqueueDownload([source]);await drain(e);
  const watch=e.store.watches()[0];e.store.run('UPDATE watches SET settings=? WHERE id=?',JSON.stringify(settings({codec:'h264',onlySmaller:false,preset:'fast'})),watch.id);
  await e.engine.scan();await new Promise(resolve=>setTimeout(resolve,10));await e.engine.scan();e.store.setPaused(false);e.engine.tick();await e.engine.workerPromise;
  const r=e.archive.row(id);assert.equal(r.state,'ready',JSON.stringify(e.store.all('SELECT state,error FROM jobs'))+r.data.error);
  assert.equal(path.relative(e.c.outputRoot,r.data.result),'Actual.2026/Actual.2026.mkv');await assert.rejects(fs.stat(r.local_source),{code:'ENOENT'});assert.equal(await digest(source),originalHash);
  assert.equal(e.store.get('SELECT COUNT(*) AS n FROM returns').n,0);
});
test('Work HTTP endpoints protect mutations and upload one raw file with auth',async t=>{
  const e=await setup(t);e.c.username='user';e.c.password='test';
  await new Promise(resolve=>e.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+e.server.address().port;
  const authorization='Basic '+Buffer.from('user:test').toString('base64');
  let response=await fetch(base+'/api/archive/receive?name=HTTP.mp4',{method:'POST',body:'video'});assert.equal(response.status,401);
  response=await fetch(base+'/api/archive/receive?name=HTTP.mp4',{method:'POST',headers:{authorization},body:'video'});assert.equal(response.status,403);
  response=await fetch(base+'/api/archive/receive?name=HTTP.mp4',{method:'POST',headers:{authorization,'X-ReelShrink':'1'},body:'video'});assert.equal(response.status,201,await response.clone().text());
  const {id}=await response.json();assert.equal(e.archive.row(id).state,'local');
  response=await fetch(base+'/api/returns',{headers:{authorization}});assert.equal(response.status,410);
  response=await fetch(base+'/returns',{headers:{authorization},redirect:'manual'});assert.equal(response.status,302);
  response=await fetch(base+'/api/archive/remove',{method:'POST',headers:{authorization,'X-ReelShrink':'1','Content-Type':'application/json'},body:JSON.stringify({ids:[id],confirmation:'wrong'})});assert.equal(response.status,400);assert.ok(e.archive.row(id));
  response=await fetch(base+'/api/archive/remove',{method:'POST',headers:{authorization,'X-ReelShrink':'1','Content-Type':'application/json'},body:JSON.stringify({ids:[id],confirmation:'SLET WORK'})});assert.equal(response.status,200,await response.clone().text());assert.equal(e.archive.row(id),null);
});
test('discovered episodes get isolated folders and deleting one preserves the other',async t=>{
  const e=await setup(t),shared=path.join(e.c.mediaRoots[0],'Series');await fs.mkdir(shared);
  await fs.writeFile(path.join(shared,'Episode1.mkv'),'one');await fs.writeFile(path.join(shared,'Episode2.mkv'),'two');
  await e.archive.rescanWork();while(e.engine.scanning)await new Promise(resolve=>setTimeout(resolve,5));
  const rows=e.archive.list();assert.equal(rows.length,2);assert.notEqual(path.dirname(rows[0].local_source),path.dirname(rows[1].local_source));
  await e.archive.remove([rows[0].id]);assert.ok(await fs.stat(rows[1].local_source));
});
