import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { config, settings, mediaPath } from '../app/config.mjs';
import { Store } from '../app/store.mjs';
import { Engine } from '../app/engine.mjs';
import { bundleFor, signatureFor, discover, probe, run } from '../app/media.mjs';
import { createService } from '../app/server.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function env(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelshrink-test-'));
  const media=path.join(root,'media'),output=path.join(root,'output'),state=path.join(root,'config');
  await fs.mkdir(media);await fs.mkdir(output);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const c=config({MEDIA_ROOTS:media,OUTPUT_ROOT:output,CONFIG_DIR:state,ENCODE_THREADS:'1',MIN_FREE_GB:'0'});
  c.stableSeconds=0.025;
  return {root,media,c};
}
async function fixture(e,{lowQuality=false,hdr=false,multi=true}={}) {
  const source=path.join(e.media,'Movie & Danish (2026).mkv');
  const srt=path.join(e.root,'embedded.srt'),attachment=path.join(e.root,'attachment.txt'),metadata=path.join(e.root,'chapters.txt');
  await fs.writeFile(srt,'1\n00:00:00,200 --> 00:00:02,800\nEmbedded subtitle\n');
  await fs.writeFile(attachment,'Attachment preserved by stream copying.');
  await fs.writeFile(metadata,';FFMETADATA1\ntitle=Integration fixture\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=First chapter\n');
  const args=['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=480x270:rate=24:duration=3','-f','lavfi','-i','sine=frequency=440:duration=3','-f','lavfi','-i','sine=frequency=880:duration=3','-i',srt,'-i',metadata,'-map','0:v','-map','1:a'];
  if(multi)args.push('-map','2:a','-map','3:s');
  args.push('-map_metadata','4','-map_chapters','4','-threads','1','-c:v',lowQuality?'libx264':'mpeg4');
  args.push(...(lowQuality?['-crf','43']:['-q:v','2']));
  args.push('-c:a','aac','-c:s','srt');
  if(multi)args.push('-metadata:s:s:0','language=eng','-disposition:s:0','default+forced','-attach',attachment,'-metadata:s:t','mimetype=text/plain');
  if(hdr)args.push('-color_trc','smpte2084','-color_primaries','bt2020');
  args.push(source);
  await run(e.c.ffmpeg,args,{timeout:30000});
  return source;
}
async function engineFor(t,e,opts={}) {
  const store=new Store(e.c.configDir),engine=new Engine(e.c,store);
  await engine.init();
  t.after(async()=>{await engine.stop();store.close();});
  const watch=store.addWatch('Films',e.media,settings(opts));
  return {store,engine,watch};
}
async function scanStable(engine){await engine.scan();await sleep(40);await engine.scan();}
async function finish(engine){engine.tick();await engine.workerPromise;}

test('real H.265 encode preserves resolution, audio, chapters, attachments and selectable SRT tracks',async t=>{
  const e=await env(t),source=await fixture(e);
  const prefix=source.slice(0,-4);
  await fs.writeFile(prefix+'.da.srt','1\n00:00:00,300 --> 00:00:02,600\nRødgrød med fløde – æ ø å\n');
  await fs.mkdir(path.join(e.media,'Subs'));
  const french=path.join(e.media,'Subs',path.basename(prefix)+'.fr.srt');
  await fs.writeFile(french,Buffer.from('1\n00:00:00,300 --> 00:00:02,600\nCaf\xe9\n','latin1'));
  await fs.writeFile(prefix+'.nfo','<movie><title>Fixture</title></movie>');
  const before=await hash(source),{store,engine}=await engineFor(t,e);
  await engine.scan();assert.equal(store.all('SELECT * FROM jobs').length,0,'first observation must not enqueue');
  await sleep(40);await engine.scan();assert.equal(store.all('SELECT * FROM jobs').length,1);
  await finish(engine);
  const job=store.job(store.get('SELECT id FROM jobs').id);
  assert.equal(job.state,'completed',job.error+'\n'+job.log);
  assert.ok(job.output_bytes<job.input_bytes);
  assert.equal(await hash(source),before,'original must remain byte-identical');
  const out=await probe(job.output,e.c);
  assert.equal(out.video.codec_name,'hevc');assert.equal(out.video.width,480);assert.equal(out.video.height,270);
  assert.equal(out.chapters.length,1);
  assert.equal(out.streams.filter(s=>s.codec_type==='audio').length,2);
  assert.equal(out.streams.filter(s=>s.codec_type==='attachment').length,1);
  const subs=out.streams.filter(s=>s.codec_type==='subtitle');assert.equal(subs.length,3);
  assert.deepEqual(subs.map(s=>s.tags.language).sort(),['dan','eng','fra']);
  assert.ok(subs.every(s=>!s.disposition.default&&!s.disposition.forced));
  const dan=subs.find(s=>s.tags.language==='dan');
  const extracted=await run(e.c.ffmpeg,['-v','error','-i',job.output,'-map',`0:${dan.index}`,'-f','srt','-']);
  assert.match(extracted.out,/Rødgrød med fløde – æ ø å/);
  const fra=subs.find(s=>s.tags.language==='fra');
  assert.match((await run(e.c.ffmpeg,['-v','error','-i',job.output,'-map',`0:${fra.index}`,'-f','srt','-'])).out,/Café/);
  const audioHash=file=>run(e.c.ffmpeg,['-v','error','-i',file,'-map','0:a:0','-c','copy','-f','hash','-']);
  assert.equal((await audioHash(source)).out,(await audioHash(job.output)).out,'audio packets must remain byte-identical');
  assert.equal(await fs.readFile(path.join(path.dirname(job.output),path.basename(prefix)+'.nfo'),'utf8'),'<movie><title>Fixture</title></movie>');
  assert.equal((await fs.readdir(engine.stageRoot)).length,0);
  await engine.scan();assert.equal(store.all('SELECT id FROM jobs').length,1,'unchanged source must not encode twice');
  // A subtitle arriving after completion creates exactly one new revision.
  await fs.writeFile(prefix+'.de.srt','1\n00:00:00,300 --> 00:00:02,000\nHallo\n');
  await scanStable(engine);assert.equal(store.all('SELECT id FROM jobs').length,2);
  engine.cancel(store.get("SELECT id FROM jobs WHERE state='queued'").id);
  // Simulate a crash after directory rename but before final state commit.
  store.updateJob(job.id,{state:'running'});await engine.init();assert.equal(store.job(job.id).state,'completed');
  console.log(JSON.stringify({fixture:'real H.265 + SRT',inputBytes:job.input_bytes,outputBytes:job.output_bytes,savedPercent:Math.round(100*job.saved_bytes/job.input_bytes)}));
});

test('matching never attaches another episode subtitles; symlink files and directories are excluded',async t=>{
  const e=await env(t);
  for(const name of ['Show.S01E01.mkv','Show.S01E010.mkv','Show.S01E01.da.srt','Show.S01E010.en.srt','unrelated.srt'])await fs.writeFile(path.join(e.media,name),'x');
  const one=await bundleFor(path.join(e.media,'Show.S01E01.mkv'));
  assert.deepEqual(one.subtitles.map(s=>path.basename(s.path)),['Show.S01E01.da.srt']);
  const outside=path.join(e.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret.mkv'),'x');
  await fs.symlink(outside,path.join(e.media,'escape'));await fs.symlink(path.join(outside,'secret.mkv'),path.join(e.media,'link.mkv'));
  assert.equal((await discover(e.media)).length,2);
  assert.throws(()=>mediaPath(path.join(e.media,'escape'),e.c));
  assert.throws(()=>mediaPath(path.join(e.media,'..','outside'),e.c));
});

test('source changes reset stability and do not process partly copied videos',async t=>{
  const e=await env(t),{store,engine}=await engineFor(t,e),file=path.join(e.media,'Growing.mkv');
  await fs.writeFile(file,'part one');await engine.scan();await sleep(40);
  await fs.appendFile(file,'part two');await engine.scan();assert.equal(store.all('SELECT id FROM jobs').length,0);
  await sleep(40);await engine.scan();assert.equal(store.all('SELECT id FROM jobs').length,1);
});

test('HDR is skipped and source is unchanged',async t=>{
  const e=await env(t),source=await fixture(e,{hdr:true}),before=await hash(source),{store,engine}=await engineFor(t,e);
  await scanStable(engine);await finish(engine);const j=store.job(store.get('SELECT id FROM jobs').id);
  assert.equal(j.state,'skipped');assert.match(j.error,/HDR/);assert.equal(await hash(source),before);assert.equal(j.output,null);
});

test('larger output is discarded when onlySmaller is selected',async t=>{
  const e=await env(t),source=await fixture(e,{lowQuality:true,multi:false}),before=await hash(source),{store,engine}=await engineFor(t,e,{quality:'high'});
  await scanStable(engine);await finish(engine);const j=store.job(store.get('SELECT id FROM jobs').id);
  assert.equal(j.state,'skipped',j.error);assert.ok(j.output_bytes>=j.input_bytes);assert.equal(j.output,null);
  assert.equal(await hash(source),before);assert.equal((await fs.readdir(engine.stageRoot)).length,0);
});

test('H.264 stereo conversion works and a resolution ceiling never upscales smaller video',async t=>{
  const e=await env(t);await fixture(e,{multi:false});
  const {store,engine}=await engineFor(t,e,{codec:'h264',audio:'aac_stereo',onlySmaller:false,maxHeight:1080});
  await scanStable(engine);await finish(engine);const j=store.job(store.get('SELECT id FROM jobs').id);
  assert.equal(j.state,'completed',j.error+'\n'+j.log);
  const media=await probe(j.output,e.c);assert.equal(media.video.codec_name,'h264');
  assert.equal(media.video.width,480);assert.equal(media.video.height,270);
  assert.equal(media.streams.find(s=>s.codec_type==='audio').channels,2);assert.equal(media.streams.filter(s=>s.codec_type==='subtitle').length,0);
});

test('downscaling preserves aspect ratio and handles videos without audio',async t=>{
  const e=await env(t),source=path.join(e.media,'Portrait.mkv');
  await run(e.c.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=640x800:rate=6:duration=1.5','-threads','1','-c:v','mpeg4','-q:v','2',source]);
  const {store,engine}=await engineFor(t,e,{codec:'h264',maxHeight:720,onlySmaller:false});
  await scanStable(engine);await finish(engine);const j=store.job(store.get('SELECT id FROM jobs').id);
  assert.equal(j.state,'completed',j.error+'\n'+j.log);
  const result=await probe(j.output,e.c);assert.equal(result.video.height,720);assert.equal(result.video.width,576);assert.equal(result.streams.filter(s=>s.codec_type==='audio').length,0);
});

test('MP4 mov_text subtitles are converted into selectable MKV text tracks',async t=>{
  const e=await env(t),source=await fixture(e),mp4=path.join(e.media,'Movie.mp4');
  await run(e.c.ffmpeg,['-v','error','-i',source,'-map','0:v:0','-map','0:a:0','-map','0:s:0','-c','copy','-c:s','mov_text',mp4]);
  await fs.unlink(source);
  const {store,engine}=await engineFor(t,e);
  await scanStable(engine);await finish(engine);const j=store.job(store.get('SELECT id FROM jobs').id);
  assert.equal(j.state,'completed',j.error+'\n'+j.log);
  const subtitle=(await probe(j.output,e.c)).streams.find(s=>s.codec_type==='subtitle');
  assert.equal(subtitle.codec_name,'subrip');assert.equal(subtitle.disposition.default,0);assert.equal(subtitle.disposition.forced,0);
});

test('a changed queued source and insufficient output space cannot produce a final file',async t=>{
  const e=await env(t),source=await fixture(e),{store,engine}=await engineFor(t,e);
  await scanStable(engine);await fs.appendFile(source,'changed');await finish(engine);
  const j=store.job(store.get('SELECT id FROM jobs').id);assert.equal(j.state,'failed');assert.match(j.error,/ændret/);assert.equal(j.output,null);
  // Fresh revision is valid but fails the explicit space check before encoding.
  await scanStable(engine);e.c.minFreeBytes=Number.MAX_SAFE_INTEGER;await finish(engine);
  const second=store.job(store.get('SELECT id FROM jobs WHERE id!=?',j.id).id);
  assert.equal(second.state,'failed');assert.match(second.error,/plads/);assert.equal(second.output,null);
});

test('pause, cancellation and restart recovery preserve queue state and originals',async t=>{
  const e=await env(t),source=await fixture(e),{store,engine}=await engineFor(t,e),before=await hash(source);
  await scanStable(engine);const id=store.get('SELECT id FROM jobs').id;
  store.setPaused(true);engine.tick();assert.equal(engine.active,null);assert.equal(store.job(id).state,'queued');
  store.setPaused(false);engine.tick();engine.cancel(id);await engine.workerPromise;
  assert.equal(store.job(id).state,'cancelled');assert.equal(await hash(source),before);
  assert.equal((await fs.readdir(engine.stageRoot)).length,0);
  store.updateJob(id,{state:'running',progress:42});store.setPaused(true);await engine.init();
  assert.equal(store.job(id).state,'queued');assert.equal(store.job(id).progress,0);assert.equal(store.paused(),true);
});

test('API enforces authentication, same-origin writes and media boundaries; UI assets load',async t=>{
  const e=await env(t);e.c.username='tester';e.c.password='a-long-test-password';
  const service=await createService(e.c,{background:false});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>service.close());
  const origin='http://127.0.0.1:'+service.server.address().port;
  const auth='Basic '+Buffer.from(e.c.username+':'+e.c.password).toString('base64');
  const request=(p,options={})=>fetch(origin+p,{...options,headers:{Authorization:auth,...options.headers}});
  assert.equal((await fetch(origin+'/api/status')).status,401);
  assert.equal((await fetch(origin+'/api/health')).status,200);
  for(const file of ['/','/app.js','/style.css','/favicon.svg']){const response=await request(file);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);}
  const data={name:'API Movies',path:e.media,settings:settings()};
  const payload={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};
  assert.equal((await request('/api/watches',payload)).status,403);
  payload.headers['X-ReelShrink']='1';payload.headers.Origin='https://example.invalid';assert.equal((await request('/api/watches',payload)).status,403);
  delete payload.headers.Origin;const created=await request('/api/watches',payload);assert.equal(created.status,201);const w=await created.json();
  assert.equal((await request('/api/watches',payload)).status,400,'overlapping watches must be rejected');
  const watchList=await (await request('/api/watches')).json();assert.equal(watchList[0].id,w.id);
  assert.equal((await request('/api/browse?path='+encodeURIComponent(e.root))).status,400);
  assert.equal((await (await request('/api/config')).json()).password,undefined);
  const pause=await request('/api/queue',{method:'POST',headers:{'X-ReelShrink':'1','Content-Type':'application/json'},body:JSON.stringify({paused:true})});
  assert.equal(pause.status,200);assert.equal((await (await request('/api/status')).json()).paused,true);
});
