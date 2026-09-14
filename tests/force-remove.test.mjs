import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createService} from '../app/server.mjs';
import {config} from '../app/config.mjs';
import {forceRemove} from '../app/force-remove.mjs';

async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'force-')),nas=path.join(root,'nas');await fs.mkdir(nas);
 const c=config({WORK_ROOT:path.join(root,'work'),MEDIA_ROOTS:nas,CONFIG_DIR:path.join(root,'config'),MIN_FREE_GB:'0'});
 const e=await createService(c,{background:false});e.store.setPaused(true);e.engine.scan=async()=>{};
 t.after(async()=>{await e.close();await fs.rm(root,{recursive:true,force:true});});return {...e,c,nas};
}
async function item(e,name){
 const source=path.join(e.nas,name+'.mp4');await fs.writeFile(source,'NAS ORIGINAL');
 const [id]=await e.archive.enqueueDownload([source]);await e.archive.workerPromise;
 const r=e.archive.row(id),w=e.store.watches()[0];
 const j=e.store.enqueue(w,r.local_source,name+'.mp4','sig',{subtitles:[],sidecars:[]},12);
 e.store.updateJob(j,{state:'failed'});return {r,j};
}
test('force forgets failed transfers and hidden history, removes local backup/output, allows reimport',async t=>{
 const e=await setup(t),{r,j}=await item(e,'Film'),other=await item(e,'Other');
 const output=path.join(e.c.outputRoot,'Film','new.mkv');await fs.mkdir(path.dirname(output));await fs.writeFile(output,'encoded');
 await fs.rename(r.local_source,r.local_source+'.WORK_OLD');e.store.updateJob(j,{output});e.store.removeJobs([j]);
 e.archive.update(r.id,'attention',{...r.data,result:output,workOld:r.local_source+'.WORK_OLD',upload:{phase:'installing'}});
 e.archive.saveBatch({id:'batch',ids:[r.id,other.r.id],limit:2});
 const rid=randomUUID();e.store.run('INSERT INTO returns VALUES (?,?,?,?,?,?,?,?,?)',rid,output,'stamp',r.local_source,'reelshrink','failed',null,JSON.stringify({jobId:j}),Date.now());
 e.store.run('INSERT INTO returned_files VALUES (?,?,?)',r.local_source,'stamp',rid);
 // The NAS original directory no longer has its recorded identity.
 e.archive.update(r.id,'attention',{...e.archive.row(r.id).data,directoryId:'obsolete'});
 await forceRemove(e.archive,'archive',[r.id],'FORCE SLET');
 assert.equal(e.archive.row(r.id),null);assert.equal(e.store.get('SELECT id FROM jobs WHERE id=?',j),undefined);
 assert.equal(e.store.get('SELECT id FROM returns WHERE id=?',rid),undefined);assert.equal(e.store.all('SELECT * FROM returned_files').length,0);
 await assert.rejects(fs.stat(path.dirname(r.local_source)),{code:'ENOENT'});await assert.rejects(fs.stat(output),{code:'ENOENT'});
 assert.equal(await fs.readFile(r.source,'utf8'),'NAS ORIGINAL');assert.ok(await fs.stat(other.r.local_source));
 assert.deepEqual(e.archive.batch().ids,[other.r.id]);
 const [again]=await e.archive.enqueueDownload([r.source]);await e.archive.workerPromise;assert.notEqual(again,r.id);
});
test('encoding bulk removal includes all signatures and tolerates missing Work/origin paths',async t=>{
 const e=await setup(t),a=await item(e,'A'),b=await item(e,'B');
 await fs.rm(path.dirname(a.r.local_source),{recursive:true});await fs.unlink(a.r.source);
 await forceRemove(e.archive,'jobs',[a.j,b.j],'FORCE SLET');
 assert.equal(e.store.all('SELECT * FROM jobs').length,0);assert.equal(e.archive.list().length,0);
 assert.equal(await fs.readFile(b.r.source,'utf8'),'NAS ORIGINAL');
});
test('symlink ancestor and obsolete outside paths are forgotten without deleting external files',async t=>{
 const e=await setup(t),{r,j}=await item(e,'Film');
 await fs.rm(path.dirname(r.local_source),{recursive:true});await fs.symlink(e.nas,path.dirname(r.local_source));
 e.store.updateJob(j,{output:r.source});
 const result=await forceRemove(e.archive,'jobs',[j],'FORCE SLET');
 assert.ok(result.skippedPaths.includes(r.source));assert.equal(await fs.readFile(r.source,'utf8'),'NAS ORIGINAL');assert.equal(e.archive.list().length,0);
});
test('selected running encoder is aborted and awaited before deleting its records',async t=>{
 const e=await setup(t),{r,j}=await item(e,'Film'),controller=new AbortController();
 e.engine.active={id:j,controller};e.store.updateJob(j,{state:'running'});
 e.engine.workerPromise=new Promise(resolve=>controller.signal.addEventListener('abort',()=>setTimeout(()=>{e.store.updateJob(j,{state:'cancelled'});e.engine.active=null;resolve();},10)));
 await forceRemove(e.archive,'jobs',[j],'FORCE SLET');assert.ok(controller.signal.aborted);assert.equal(e.store.all('SELECT * FROM jobs').length,0);assert.equal(e.archive.row(r.id),null);
});
test('force API requires CSRF header and explicit confirmation; shared folders preserve other entries',async t=>{
 const e=await setup(t),a=await item(e,'A'),b=await item(e,'B');
 const moved=path.join(path.dirname(a.r.local_source),'B.mp4');await fs.rename(b.r.local_source,moved);
 e.store.run('UPDATE archive_items SET local_source=? WHERE id=?',moved,b.r.id);e.store.run('UPDATE jobs SET source=? WHERE id=?',moved,b.j);
 await new Promise(resolve=>e.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${e.server.address().port}/api/jobs/force-remove`;
 const call=(headers,data)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 assert.equal((await call({},{ids:[a.j],confirmation:'FORCE SLET'})).status,403);
 assert.equal((await call({'X-ReelShrink':'1'},{ids:[a.j],confirmation:'wrong'})).status,400);
 assert.equal((await call({'X-ReelShrink':'1'},{ids:[a.j],confirmation:'FORCE SLET'})).status,200);
 assert.ok(await fs.stat(moved));assert.ok(e.store.job(b.j));await assert.rejects(fs.stat(a.r.local_source),{code:'ENOENT'});
});
test('failed local deletion preserves records for retry and always releases maintenance locks',async t=>{
 const e=await setup(t),{r,j}=await item(e,'Film'),rm=fs.rm;
 fs.rm=async(f,...args)=>{if(f===path.dirname(r.local_source))throw Object.assign(new Error('denied'),{code:'EACCES'});return rm(f,...args);};
 try{await assert.rejects(forceRemove(e.archive,'jobs',[j],'FORCE SLET'),/denied/);}finally{fs.rm=rm;}
 assert.ok(e.store.job(j));assert.ok(e.archive.row(r.id));assert.equal(e.engine.maintenance,false);assert.equal(e.archive.editing,false);
 await forceRemove(e.archive,'jobs',[j],'FORCE SLET');assert.equal(e.archive.row(r.id),null);
});
test('force removing the whole risky batch does not refill it; restart does not resurrect entries',async t=>{
 const e=await setup(t);e.archive.setOptions({mode:'speedy_risky',buffer:1});
 const {r,j}=await item(e,'Film'),batch=e.archive.batch();
 await forceRemove(e.archive,'jobs',[j],'FORCE SLET');assert.deepEqual(e.archive.batch().ids,[]);
 const source=path.join(e.nas,'Next.mp4');await fs.writeFile(source,'next original');const [next]=await e.archive.enqueueDownload([source]);assert.equal(e.archive.row(next).state,'queued_download');
 const reopened=await createService(e.c,{background:false});
 try{assert.equal(reopened.archive.row(r.id),null);assert.equal(reopened.store.job(j),null);assert.equal(reopened.archive.batch().id,batch.id);reopened.archive.tick();assert.equal(reopened.archive.row(next).state,'queued_download');}finally{await reopened.close();}
});
test('local force removal does not wait for or cancel an unrelated NAS library scan',async t=>{
 const e=await setup(t),{j}=await item(e,'Film');e.archive.libraryScanning=true;
 const controller=e.archive.libraryScanController;
 try{
  await forceRemove(e.archive,'jobs',[j],'FORCE SLET');
  assert.equal(controller.signal.aborted,false);assert.equal(e.archive.libraryScanning,true);assert.equal(e.store.job(j),null);
 }finally{e.archive.libraryScanning=false;}
});
