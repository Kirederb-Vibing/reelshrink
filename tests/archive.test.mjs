import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, settings } from '../app/config.mjs';
import { createService } from '../app/server.mjs';
import { digest, fingerprint } from '../app/returner.mjs';
import { run } from '../app/media.mjs';

async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelshrink-archive-'));
  const library=path.join(root,'nas');await fs.mkdir(library);
  const env={MEDIA_ROOTS:library,MEDIA_DRIVE_TYPES:'network',WORK_ROOT:path.join(root,'work'),CONFIG_DIR:path.join(root,'config'),MIN_FREE_GB:'0',ENCODE_THREADS:'1'};
  const c=config(env);c.stableSeconds=.001;
  const service=await createService(c,{background:false});
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});});
  return {...service,root,library,c,env};
}
async function original(e,name='Film.2026.mp4') {
  const file=path.join(e.library,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'original video bytes');return file;
}
async function download(e,sources) {
  const ids=await e.archive.enqueueDownload(sources);
  while(e.archive.active||e.archive.list().some(r=>r.state==='queued_download')) {await e.archive.workerPromise;e.archive.tick();}
  return ids.map(id=>e.archive.row(id));
}
// Fixture models a completed local return/approval. A separate test below runs FFmpeg.
async function approve(e,r) {
  const target=r.local_source.replace(/\.[^.]+$/,'.mkv');await fs.unlink(r.local_source);await fs.writeFile(target,'smaller encoded video');
  const id=randomUUID(),details={target,hash:await digest(target),targetStamp:await fingerprint(target)};
  e.store.run('INSERT INTO returns VALUES (?,?,?,?,?,?,?,?,?)',id,path.join(e.c.outputRoot,id+'.mkv'),'stamp',r.local_source,'reelshrink','deleted',null,JSON.stringify(details),Date.now());return target;
}
async function send(e,ids){e.archive.enqueueUpload(ids,'SEND OG ERSTAT');while(e.archive.active||e.archive.list().some(r=>r.state==='queued_upload')){await e.archive.workerPromise;e.archive.tick();}}

test('work mode maps only processing to local subdirectories and validates drive declarations',()=>{
  const env={WORK_ROOT:'/work',MEDIA_ROOTS:'/nas/film:/nas/series',MEDIA_DRIVE_TYPES:'network:local'};
  const c=config(env);assert.deepEqual(c.mediaRoots,['/work/library']);assert.equal(c.outputRoot,'/work/encoded');assert.deepEqual(c.archiveDrives.map(d=>d.type),['network','local']);
  for(const values of [{MEDIA_DRIVE_TYPES:'network'},{MEDIA_DRIVE_TYPES:'network:invalid'},{WORK_DRIVE_TYPE:'network'},{WORK_ROOT:'/nas'},{CONFIG_DIR:'/work/config'}])assert.throws(()=>config({...env,...values}));
});

test('work output symlink is rejected before the engine writes to its external target',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelshrink-work-boundary-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const work=path.join(root,'work'),nas=path.join(root,'nas');await fs.mkdir(work);await fs.mkdir(nas);
  await fs.symlink(nas,path.join(work,'encoded'));
  const c=config({WORK_ROOT:work,MEDIA_ROOTS:nas,CONFIG_DIR:path.join(root,'config')});
  await assert.rejects(createService(c,{background:false}),/symlinks/);
  assert.deepEqual(await fs.readdir(nas),[],'startup must not create engine staging on the library drive');
  await assert.rejects(fs.stat(c.configDir),{code:'ENOENT'});
});

test('selected downloads preserve NAS originals, record paths and sidecars, and never upload automatically',async t=>{
  const e=await setup(t),source=await original(e,'Folder/Film.2026.mp4');
  await fs.writeFile(source.replace('.mp4','.da.srt'),'subtitle');await fs.writeFile(path.join(path.dirname(source),'unrelated.txt'),'keep');
  const [r]=await download(e,[source]);assert.equal(r.state,'local',r.data.error);
  assert.equal(r.data.originalDir,path.dirname(source));assert.equal(r.data.manifest.length,2);
  assert.equal(await digest(source),await digest(r.local_source));
  assert.ok(r.data.manifest.every(f=>f.hash));assert.equal(e.archive.status().items[0].canSend,false);
  assert.throws(()=>e.archive.enqueueUpload([r.id],'SEND OG ERSTAT'),/OLD/);
  assert.throws(()=>e.archive.enqueueUpload([r.id],''),/SEND OG ERSTAT/);
  await assert.rejects(e.archive.enqueueDownload([source]),/allerede/);
  await approve(e,r);e.archive.tick();assert.equal(e.archive.row(r.id).state,'local');assert.ok(await fs.stat(source));
});

test('only selected approved item uploads; shared metadata and unrelated episodes remain unchanged',async t=>{
  const e=await setup(t),first=await original(e,'Series/Show.S01E01.mp4'),second=await original(e,'Series/Show.S01E02.mp4');
  const subtitle=first.replace('.mp4','.da.srt');await fs.writeFile(subtitle,'subtitle');const stamp=await fingerprint(subtitle);
  const rows=await download(e,[first,second]);for(const r of rows)await approve(e,r);
  const extra=path.join(path.dirname(first),'new-file.nfo');await fs.writeFile(extra,'added since download');
  await send(e,[rows[0].id]);const r=e.archive.row(rows[0].id);assert.equal(r.state,'sent',r.data.error);
  await assert.rejects(fs.stat(first),{code:'ENOENT'});assert.equal(await fs.readFile(first.replace('.mp4','.mkv'),'utf8'),'smaller encoded video');
  assert.equal(await fingerprint(subtitle),stamp);assert.equal(await fs.readFile(extra,'utf8'),'added since download');assert.ok(await fs.stat(second));
  assert.equal(e.archive.row(rows[1].id).state,'local');assert.equal(r.data.upload.files.length,1);
  assert.equal(e.store.archiveHeld(rows[0].local_source),true);
});

test('changed original, replacement collision, and insufficient space stop before original changes',async t=>{
  for(const kind of ['changed','collision','space','links'])await t.test(kind,async t=>{
    const e=await setup(t),source=await original(e),[r]=await download(e,[source]);await approve(e,r);
    if(kind==='changed')await fs.appendFile(source,'modified');
    if(kind==='collision')await fs.writeFile(source.replace('.mp4','.mkv'),'someone else');
    if(kind==='space')e.c.minFreeBytes=Number.MAX_SAFE_INTEGER;
    if(kind==='links')t.mock.method(fs,'link',async()=>{throw new Error('Hardlinks unsupported');});
    const before=await digest(source);await send(e,[r.id]);assert.equal(e.archive.row(r.id).state,'attention');assert.equal(await digest(source),before);
  });
});

test('interrupted installation resumes from persisted journal without deleting untracked files',async t=>{
  const e=await setup(t),source=await original(e),[r]=await download(e,[source]);await approve(e,r);
  const before=await digest(source),link=fs.link;
  const mock=t.mock.method(fs,'link',async(src,dest)=>{if(dest===source.replace('.mp4','.mkv'))throw new Error('Injected disconnect');return link(src,dest);});
  await send(e,[r.id]);let row=e.archive.row(r.id);assert.equal(row.state,'attention');assert.equal(row.data.upload.phase,'installing');
  assert.equal(await digest(path.join(row.data.upload.dir,'old-0')),before);
  mock.mock.restore();await e.archive.init();e.archive.retry(r.id);await e.archive.workerPromise;
  row=e.archive.row(r.id);assert.equal(row.state,'sent',row.data.error);assert.equal(await fs.readFile(source.replace('.mp4','.mkv'),'utf8'),'smaller encoded video');
});

test('partial cleanup resumes and preserves a newly added unrelated file',async t=>{
  const e=await setup(t),source=await original(e),[r]=await download(e,[source]);await approve(e,r);
  const unlink=fs.unlink;let failed=false;
  const mock=t.mock.method(fs,'unlink',async file=>{if(file.endsWith('/old-0')&&!failed){failed=true;throw new Error('Disconnected during cleanup');}return unlink(file);});
  await send(e,[r.id]);assert.equal(e.archive.row(r.id).data.upload.phase,'cleanup');mock.mock.restore();
  const extra=path.join(e.library,'extra.txt');await fs.writeFile(extra,'keep');e.archive.retry(r.id);await e.archive.workerPromise;
  assert.equal(e.archive.row(r.id).state,'sent',e.archive.row(r.id).data.error);assert.equal(await fs.readFile(extra,'utf8'),'keep');
});

test('corrupted staged content blocks resumed installation and preserves the backed-up original',async t=>{
  const e=await setup(t),source=await original(e),[r]=await download(e,[source]);await approve(e,r);
  const before=await digest(source),link=fs.link;
  const mock=t.mock.method(fs,'link',async(src,dest)=>{if(dest===source.replace('.mp4','.mkv'))throw new Error('Interrupted');return link(src,dest);});
  await send(e,[r.id]);mock.mock.restore();const j=e.archive.row(r.id).data.upload;
  await fs.appendFile(j.files[0].temp,'corrupt');e.archive.retry(r.id);await e.archive.workerPromise;
  assert.equal(e.archive.row(r.id).state,'attention');assert.equal(await digest(path.join(j.dir,'old-0')),before);
});

test('local cleanup needs explicit approval and verified server data, and leaves other local items intact',async t=>{
  const e=await setup(t),first=await original(e),second=await original(e,'Other.2026.mp4'),rows=await download(e,[first,second]);
  await approve(e,rows[0]);await send(e,[rows[0].id]);
  await assert.rejects(e.archive.cleanup([rows[0].id],''),/SLET LOKAL/);
  await assert.rejects(e.archive.cleanup([rows[1].id],'SLET LOKAL'),/afsendte/);
  await e.archive.cleanup([rows[0].id],'SLET LOKAL');assert.equal(e.archive.row(rows[0].id).state,'cleaned');
  await assert.rejects(fs.stat(path.dirname(rows[0].local_source)),{code:'ENOENT'});assert.ok(await fs.stat(rows[1].local_source));assert.ok(await fs.stat(first.replace('.mp4','.mkv')));
  await approve(e,rows[1]);await send(e,[rows[1].id]);await fs.appendFile(second.replace('.mp4','.mkv'),'changed');
  await assert.rejects(e.archive.cleanup([rows[1].id],'SLET LOKAL'),/ændret/);assert.ok(await fs.stat(rows[1].local_source.replace('.mp4','.mkv')));
});

test('symlinks, unmounted/replaced folders and new conflicting targets block transfer',async t=>{
  const e=await setup(t),source=await original(e,'Folder/Film.mp4');
  const alias=path.join(e.library,'alias');await fs.symlink(path.dirname(source),alias);
  await assert.rejects(e.archive.browse(alias),/symlink/);await assert.rejects(e.archive.enqueueDownload([path.join(alias,'Film.mp4')]),/symlink/);
  const [r]=await download(e,[source]);await approve(e,r);await fs.rename(path.dirname(source),path.join(e.library,'moved'));await fs.mkdir(path.dirname(source));
  await send(e,[r.id]);assert.match(e.archive.row(r.id).data.error,/monteret/);assert.ok(await fs.stat(path.join(e.library,'moved','Film.mp4')));
});

test('failed download retries safely; a published download recovers after lost final DB update',async t=>{
  const e=await setup(t),source=await original(e);e.c.minFreeBytes=Number.MAX_SAFE_INTEGER;
  const [r]=await download(e,[source]);assert.equal(r.state,'failed_download');e.c.minFreeBytes=0;
  e.archive.retry(r.id);await e.archive.workerPromise;let row=e.archive.row(r.id);assert.equal(row.state,'local',row.data.error);
  e.archive.update(r.id,'downloading',row.data);await e.archive.init();e.archive.retry(r.id);await e.archive.workerPromise;
  assert.equal(e.archive.row(r.id).state,'local');assert.equal(await digest(source),await digest(row.local_source));
});

test('legacy NAS watches and queue are disabled; processing retry cannot escape work root',async t=>{
  const e=await setup(t),source=await original(e),w=e.store.addWatch('Legacy NAS',e.library,settings());
  const id=e.store.enqueue(w,source,path.basename(source),'old',{sidecars:[],subtitles:[]},20);
  await e.archive.init();assert.equal(e.store.watch(w.id).enabled,false);assert.equal(e.store.job(id).state,'cancelled');
  await assert.rejects(e.engine.retry(id),/Arbejdsarkiv/);
  e.store.run('UPDATE watches SET enabled=1 WHERE id=?',w.id);await e.engine.scan();assert.match(e.store.watch(w.id).scan_error,/Arbejdsarkiv/);
});

test('real encoding and local OLD approval followed by selected server upload',async t=>{
  const e=await setup(t),source=path.join(e.library,'Actual.2026.mp4');
  await run(e.c.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1','-threads','1','-c:v','mpeg4','-q:v','2',source]);
  const originalHash=await digest(source),[r]=await download(e,[source]);
  const watch=e.store.watches()[0];e.store.run('UPDATE watches SET settings=? WHERE id=?',JSON.stringify(settings({codec:'h264',onlySmaller:false,preset:'fast'})),watch.id);
  await e.engine.scan();await new Promise(resolve=>setTimeout(resolve,10));await e.engine.scan();e.engine.tick();await e.engine.workerPromise;
  const job=e.store.job(e.store.get('SELECT id FROM jobs').id);assert.equal(job.state,'completed',job.error);
  assert.ok(job.output.startsWith(e.c.workRoot));assert.equal(await digest(source),originalHash);
  await e.returner.scan();await new Promise(resolve=>setTimeout(resolve,10));await e.returner.scan();const ret=e.returner.list()[0];assert.equal(ret.state,'ready');
  e.returner.enqueue([ret.id]);await e.returner.workerPromise;assert.equal(e.returner.row(ret.id).state,'done',e.returner.row(ret.id).error);
  assert.equal(await digest(source),originalHash);assert.throws(()=>e.archive.enqueueUpload([r.id],'SEND OG ERSTAT'),/OLD/);
  await e.returner.deleteOld([ret.id],'SLET OLD');await send(e,[r.id]);assert.equal(e.archive.row(r.id).state,'sent',e.archive.row(r.id).data.error);
  assert.equal(await digest(source.replace('.mp4','.mkv')),job.output_sha256);
});

test('archive API and UI share auth/CSRF protection and legacy watch cannot be re-enabled',async t=>{
  const e=await setup(t);e.c.username='tester';e.c.password='test-secret';
  await new Promise(resolve=>e.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+e.server.address().port;
  assert.equal((await fetch(base+'/api/archive')).status,401);
  const headers={Authorization:'Basic '+Buffer.from('tester:test-secret').toString('base64')};
  for(const p of ['/archive','/archive.js','/api/archive','/api/archive/browse'])assert.equal((await fetch(base+p,{headers})).status,200);
  assert.equal((await fetch(base+'/api/archive/upload',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,403);
  const w=e.store.addWatch('Old',e.library,settings());await e.archive.init();
  const response=await fetch(base+'/api/watches/'+w.id,{method:'PUT',headers:{...headers,'Content-Type':'application/json','X-ReelShrink':'1'},body:JSON.stringify({enabled:true})});assert.equal(response.status,400);
});
