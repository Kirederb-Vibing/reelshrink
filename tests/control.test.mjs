import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createService} from '../app/server.mjs';
import {config,settings} from '../app/config.mjs';
import {run,bundleFor,signatureFor} from '../app/media.mjs';
import {digest} from '../app/returner.mjs';
import {forceRemove} from '../app/force-remove.mjs';

async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'control-')),nas=path.join(root,'nas');await fs.mkdir(nas);
  const c=config({WORK_ROOT:path.join(root,'work'),MEDIA_ROOTS:nas,CONFIG_DIR:path.join(root,'config'),MIN_FREE_GB:'0',ENCODE_THREADS:'1'});
  const e=await createService(c,{background:false});e.store.setPaused(true);
  t.after(async()=>{await e.close();await fs.rm(root,{recursive:true,force:true});});return {...e,c,root,nas};
}
async function drain(e){while(e.archive.workerPromise)await e.archive.workerPromise;}
async function scanDone(e){while(e.engine.scanning)await new Promise(r=>setTimeout(r,5));}
async function imported(e,name='Film'){
  const f=path.join(e.nas,name+'.mp4');await fs.writeFile(f,'original bytes');
  const [id]=await e.archive.enqueueDownload([f]);await drain(e);await scanDone(e);return e.archive.row(id);
}
async function complete(e,r){
  const watch=e.store.watches()[0],bundle=await bundleFor(r.local_source),signature=await signatureFor(r.local_source,bundle);
  const j=e.store.all('SELECT id FROM jobs WHERE source=?',r.local_source)[0]?.id||e.store.enqueue(watch,r.local_source,path.relative(watch.path,r.local_source),signature,bundle,(await fs.stat(r.local_source)).size);
  const output=path.join(e.c.outputRoot,path.basename(path.dirname(r.local_source)),'new.mkv');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,'encoded bytes');
  e.store.updateJob(j,{state:'completed',output,output_sha256:await digest(output),output_bytes:13});await e.archive.onCompleted(e.store.job(j));return e.archive.row(r.id);
}
test('stop persists across restart, blocks workers, allows Force Slet, and preserves manual encoding pause',async t=>{
  const e=await setup(t),r=await imported(e);e.control.stop();await e.control.task;
  assert.equal(e.control.status().readyToShutdown,true);assert.equal(e.archive.scanLibrary(),false);
  await assert.rejects(e.archive.enqueueDownload([r.source]),/Samlet stop/);
  e.engine.tick();e.archive.tick();e.returner.tick();assert.equal(e.engine.active,null);assert.equal(e.archive.active,null);assert.equal(e.returner.active,null);
  const reopened=await createService(e.c,{background:true});
  try{assert.equal(reopened.control.status().readyToShutdown,true);assert.equal(reopened.engine.scanning,false);assert.equal(reopened.archive.active,null);}finally{await reopened.close();}
  await forceRemove(e.archive,'archive',[r.id],'FORCE SLET');assert.equal(e.archive.row(r.id),null);assert.equal(e.control.status().readyToShutdown,true);
  e.control.resume();await e.control.task;assert.equal(e.store.globallyPaused(),false);assert.equal(e.store.paused(),true);
  const [id]=await e.archive.enqueueDownload([r.source]);await drain(e);assert.notEqual(id,r.id);
});
test('active import finishes and next import stays queued until explicit resume',async t=>{
  const e=await setup(t),copy=e.archive.copy.bind(e.archive);let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r);
  e.archive.copy=async(...args)=>{enteredResolve();await new Promise(r=>release=r);return copy(...args);};
  const files=[path.join(e.nas,'A.mp4'),path.join(e.nas,'B.mp4')];for(const f of files)await fs.writeFile(f,'original bytes');
  const ids=await e.archive.enqueueDownload(files);await entered;
  const s=e.control.stop();assert.equal(s.phase,'stopping');assert.equal(s.readyToShutdown,false);assert.equal(e.archive.controller.signal.aborted,false);
  assert.equal(e.control.stop().phase,'stopping');assert.throws(()=>e.control.resume(),/Vent/);release();await e.control.task;
  assert.equal(e.archive.row(ids[0]).state,'local');assert.equal(e.archive.row(ids[1]).state,'queued_download');assert.equal(e.control.status().readyToShutdown,true);
  e.archive.copy=copy;e.control.resume();await e.control.task;await drain(e);assert.equal(e.archive.row(ids[1]).state,'local');
});
test('stop aborts real encoding, retains original, and same job succeeds after resume',async t=>{
  const e=await setup(t),source=path.join(e.nas,'Video.mp4');
  await run(e.c.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=10:duration=4','-threads','1','-c:v','mpeg4','-q:v','2',source]);
  const watch=e.store.watches()[0];e.store.run('UPDATE watches SET settings=? WHERE id=?',JSON.stringify(settings({codec:'h264',onlySmaller:false,preset:'fast'})),watch.id);
  const [id]=await e.archive.enqueueDownload([source]);await drain(e);await e.engine.scan();await scanDone(e);
  e.store.setPaused(false);e.engine.tick();const jobId=e.engine.active.id;
  e.control.stop();await e.control.task;assert.equal(e.store.job(jobId).state,'queued');assert.ok(await fs.stat(e.archive.row(id).local_source));assert.equal(e.control.status().readyToShutdown,true);
  e.control.resume();await e.control.task;await e.engine.workerPromise;
  assert.equal(e.store.job(jobId).state,'completed',e.store.job(jobId).error);assert.equal(e.archive.row(id).state,'ready');assert.ok(await fs.stat(source));
});
test('stop drains active publication and never marks safe until replacement is durable',async t=>{
  const e=await setup(t),r=await complete(e,await imported(e)),copy=e.archive.copy.bind(e.archive);let release,enteredResolve;const entered=new Promise(r=>enteredResolve=r);
  e.archive.copy=async(...args)=>{enteredResolve();await new Promise(r=>release=r);return copy(...args);};
  e.archive.enqueueUpload([r.id],'SEND OG ERSTAT');await entered;e.control.stop();
  assert.equal(e.control.status().readyToShutdown,false);assert.equal(e.archive.controller.signal.aborted,false);
  release();await e.control.task;assert.equal(e.archive.row(r.id).state,'sent');assert.equal(e.control.status().readyToShutdown,true);
  assert.equal(await fs.readFile(r.source.replace('.mp4','.mkv'),'utf8'),'encoded bytes');await assert.rejects(fs.stat(r.source),{code:'ENOENT'});
});
test('HTTP stop/resume are asynchronous and CSRF protected; paused service rejects new work',async t=>{
  const e=await setup(t);await new Promise(r=>e.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+e.server.address().port;
  const post=(p,headers={'X-ReelShrink':'1'},body={})=>fetch(url+p,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/control/stop',{})).status,403);
  assert.equal((await post('/api/control/stop')).status,202);await e.control.task;
  assert.equal((await (await fetch(url+'/api/control')).json()).readyToShutdown,true);
  assert.equal((await post('/api/scan')).status,409);assert.equal((await post('/api/queue',undefined,{paused:false})).status,409);
  assert.equal((await post('/api/archive/library/scan')).status,409);
  assert.equal((await post('/api/control/resume')).status,202);await e.control.task;
  for(const page of ['/','/archive'])assert.match(await (await fetch(url+page)).text(),/control.js/);
});
test('stopped startup defers local recovery until explicit resume',async t=>{
  const e=await setup(t),r=await imported(e),watch=e.store.watches()[0],bundle=await bundleFor(r.local_source),signature=await signatureFor(r.local_source,bundle);
  const j=e.store.all('SELECT id FROM jobs WHERE source=?',r.local_source)[0]?.id||e.store.enqueue(watch,r.local_source,'Film.mp4',signature,bundle,14);
  const output=path.join(e.c.outputRoot,'Recovered','new.mkv');await fs.mkdir(path.dirname(output));await fs.writeFile(output,'encoded bytes');
  e.store.updateJob(j,{state:'completed',output,output_sha256:await digest(output),output_bytes:13});
  e.control.stop();await e.control.task;
  const reopened=await createService(e.c,{background:false});
  try{
    assert.ok(await fs.stat(r.local_source));assert.equal(reopened.archive.row(r.id).state,'local');
    reopened.control.resume();await reopened.control.task;assert.equal(reopened.archive.row(r.id).state,'ready');await assert.rejects(fs.stat(r.local_source),{code:'ENOENT'});
  }finally{await reopened.close();}
});
