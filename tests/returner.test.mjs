import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config, settings } from '../app/config.mjs';
import { Store } from '../app/store.mjs';
import { Engine } from '../app/engine.mjs';
import { Returner, identity, digest, fingerprint } from '../app/returner.mjs';
import { run, bundleFor, signatureFor, discover } from '../app/media.mjs';
import { createService } from '../app/server.mjs';

const sleep = ms => new Promise(r => setTimeout(r,ms));
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'reelshrink-return-test-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const media = path.join(root,'media'), output = path.join(root,'output'), incoming = path.join(root,'incoming');
  for (const dir of [media,output,incoming]) await fs.mkdir(dir);
  const c = config({MEDIA_ROOTS:media,OUTPUT_ROOT:output,CONFIG_DIR:path.join(root,'config'),RETURN_INPUT_ROOTS:incoming,MIN_FREE_GB:'0',ENCODE_THREADS:'1'});
  c.stableSeconds = 0.01;
  const store = new Store(c.configDir), engine = new Engine(c,store), returner = new Returner(c,store,engine);
  await engine.init(); await returner.init();
  t.after(async () => { await returner.stop(); await engine.stop(); store.close(); });
  return {root,media,output,incoming,c,store,engine,returner};
}
async function clip(e, file, duration = 1) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  await run(e.c.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i',`testsrc2=size=128x96:rate=12:duration=${duration}`,'-threads','1','-c:v','mpeg4','-q:v','2',file]);
}
async function pair(e, {job = true, name = 'Film.2026', extension = '.mp4'} = {}) {
  const original = path.join(e.media,name+extension);
  const input = path.join(job ? e.output : e.incoming,name+'.mkv');
  await clip(e,original);
  await run(e.c.ffmpeg,['-v','error','-i',original,'-threads','1','-c:v','libx264','-crf','28',input]);
  let id;
  if (job) {
    const watch = e.store.addWatch('Films',e.media,settings());
    const bundle = await bundleFor(original), signature = await signatureFor(original,bundle);
    id = e.store.enqueue(watch,original,path.basename(original),signature,bundle,(await fs.stat(original)).size);
    e.store.updateJob(id,{state:'completed',output:input,output_bytes:(await fs.stat(input)).size,output_sha256:await digest(input)});
  } else await e.returner.setOptions({automatic:false,from:e.incoming,to:e.media});
  await e.returner.scan(); await sleep(15); await e.returner.scan();
  const row = e.returner.list().find(r => r.input === input);
  return {original,input,id,row};
}
async function move(e, row) { e.returner.enqueue([row.id]); await e.returner.workerPromise; return e.returner.row(row.id); }

test('conservative identities distinguish remakes, editions, series and episodes', () => {
  assert.equal(identity('The.Matrix.1999.1080p.BluRay.x264.mkv'),identity('The Matrix (1999) 720p HEVC.mp4'));
  assert.notEqual(identity('Dune.1984.mkv'),identity('Dune.2021.mkv'));
  assert.notEqual(identity('Film.2026.Extended.mkv'),identity('Film.2026.mkv'));
  assert.notEqual(identity("Film.2026.Director's.Cut.mkv"),identity('Film.2026.mkv'));
  assert.equal(identity("Film.2026.Director's.Cut.mkv"),identity('Film.2026.Directors.Cut.mkv'));
  assert.equal(identity('Show.Name.S01E02.1080p.WEB.mkv'),identity('Show Name 1x02 720p.mp4'));
  assert.notEqual(identity('Show.S01E02.mkv'),identity('Show.S01E03.mkv'));
  assert.notEqual(identity('Other.Show.S01E02.mkv'),identity('Show.S01E02.mkv'));
  for (const file of ['Movie.mkv','sample.2026.mkv','Show.S01E01E02.mkv','Show.S01E01-E03.mkv','Show.S01E01-03.mkv','Show.S01E01.S01E02.mkv']) assert.equal(identity(file),null,file);
});

test('job provenance returns a real video, preserves OLD and sidecars, prevents re-encoding, and supports manual deletion',async t => {
  const e = await setup(t), p = await pair(e), oldHash = await digest(p.original), newHash = await digest(p.input);
  assert.equal(p.row.mode,'reelshrink'); assert.equal(p.row.state,'ready');
  const r = await move(e,p.row);
  assert.equal(r.state,'done',r.error);
  assert.equal(await digest(r.details.backup),oldHash);
  assert.equal(await digest(r.details.target),newHash);
  await assert.rejects(fs.stat(p.input),{code:'ENOENT'});
  await assert.rejects(fs.stat(p.original),{code:'ENOENT'});
  assert.deepEqual(await discover(e.media),[r.details.target]);
  await e.engine.scan(); await sleep(15); await e.engine.scan();
  assert.equal(e.store.all('SELECT id FROM jobs').length,1,'returned video must not be encoded again');
  assert.equal(e.store.job(p.id).returned_output,r.details.target);
  await assert.rejects(e.returner.deleteOld([r.id],''),/SLET OLD/);
  await e.returner.deleteOld([r.id],'SLET OLD');
  await assert.rejects(fs.stat(r.details.backup),{code:'ENOENT'});
  assert.equal(await digest(r.details.target),newHash);
  assert.equal(e.returner.row(r.id).state,'deleted');
});

test('filename comparison requires manual move even with automatic mode enabled',async t => {
  const e = await setup(t), p = await pair(e,{job:false});
  await e.returner.setOptions({automatic:true,from:e.incoming,to:e.media});
  await e.returner.scan(); await sleep(15); await e.returner.scan();
  assert.equal(e.returner.active,null); assert.ok(await fs.stat(p.original));
  const row = e.returner.list().find(r=>r.input===p.input);
  assert.equal(row.state,'ready'); assert.equal(row.mode,'filename');
  assert.equal((await move(e,row)).state,'done');
});

test('automatic watcher processes completed output once and retains OLD',async t => {
  const e = await setup(t), p = await pair(e);
  await e.returner.setOptions({automatic:true,from:'',to:''});
  await e.returner.scan(); await sleep(15); await e.returner.scan(); await e.returner.workerPromise;
  assert.equal(e.returner.row(p.row.id).state,'done',e.returner.row(p.row.id).error);
  assert.ok(await fs.stat(p.original+'.OLD'));
  await e.returner.scan(); assert.equal(e.returner.list().length,1);
});

test('ambiguous same-title files require explicit choice and stale choices cannot replace changed originals',async t => {
  const e = await setup(t), p = await pair(e,{job:false});
  const duplicate = path.join(e.media,'second','Film (2026).mp4'); await fs.mkdir(path.dirname(duplicate)); await fs.copyFile(p.original,duplicate);
  await e.returner.scan(); let row = e.returner.row(p.row.id);
  assert.equal(row.state,'ambiguous'); assert.equal(row.details.candidates.length,2);
  assert.throws(()=>e.returner.enqueue([row.id]),/klar/);
  await assert.rejects(e.returner.choose(row.id,path.join(e.media,'random.mp4')),/foreslåede/);
  await e.returner.choose(row.id,p.original);
  await fs.appendFile(p.original,'changed');
  row = await move(e,e.returner.row(row.id)); assert.equal(row.state,'failed');
  assert.ok(await fs.stat(p.input)); await assert.rejects(fs.stat(p.original+'.OLD'),{code:'ENOENT'});
});

test('existing target and OLD files are never overwritten',async t => {
  for (const conflict of ['target','backup']) await t.test(conflict,async t => {
    const e = await setup(t), p = await pair(e), hash = await digest(p.original);
    const collision = conflict === 'target' ? p.original.replace('.mp4','.mkv') : p.original+'.OLD';
    await fs.writeFile(collision,'keep this');
    const row = await move(e,p.row); assert.equal(row.state,'failed',row.error);
    assert.equal(await digest(p.original),hash); assert.equal(await fs.readFile(collision,'utf8'),'keep this'); assert.ok(await fs.stat(p.input));
  });
});

test('corrupt or wrong-duration incoming videos leave originals intact',async t => {
  for (const kind of ['corrupt','duration']) await t.test(kind,async t => {
    const e = await setup(t), p = await pair(e,{job:false}), before = await digest(p.original);
    await fs.unlink(p.input);
    if (kind === 'corrupt') await fs.writeFile(p.input,'not a video'); else await clip(e,p.input,5);
    await e.returner.scan(); await sleep(15); await e.returner.scan();
    const row = await move(e,e.returner.list().find(r=>r.input===p.input&&r.state==='ready'));
    assert.equal(row.state,'failed'); assert.equal(await digest(p.original),before); assert.ok(await fs.stat(p.input));
  });
});

test('sidecars retain target naming and a conflict blocks replacement',async t => {
  for (const conflict of [false,true]) await t.test(String(conflict),async t => {
    const e = await setup(t), p = await pair(e,{job:false}), before = await digest(p.original);
    const inputSrt = p.input.replace('.mkv','.da.srt'), targetSrt = p.original.replace('.mp4','.da.srt');
    await fs.writeFile(inputSrt,'1\n00:00:00,000 --> 00:00:00,500\nHej\n');
    if (conflict) await fs.writeFile(targetSrt,'existing different subtitle');
    const row = await move(e,p.row);
    if (conflict) { assert.equal(row.state,'failed'); assert.equal(await digest(p.original),before); assert.match(row.error,/Sidefil-konflikt/); }
    else { assert.equal(row.state,'done',row.error); assert.equal(await digest(inputSrt),await digest(targetSrt)); }
  });
});

test('same-extension replacement and explicit restore retain both versions',async t => {
  const e = await setup(t), p = await pair(e,{extension:'.mkv'}), before = await digest(p.original), incoming = await digest(p.input);
  const row = await move(e,p.row); assert.equal(row.state,'done',row.error);
  assert.equal(await digest(p.original),incoming);
  await e.returner.restore(row.id);
  assert.equal(await digest(p.original),before);
  assert.equal(await digest(row.details.target+'.RETURNED-'+row.id),incoming);
  assert.equal(await digest(row.details.backup),before);
  assert.equal(e.returner.row(row.id).state,'restored');
});

test('crash between backup and installation is held for review and can restore the original',async t => {
  const e = await setup(t), p = await pair(e), before = await digest(p.original);
  const backup = p.original+'.OLD', target = p.original.replace('.mp4','.mkv'), temp = path.join(e.media,'.return-test');
  await fs.copyFile(p.input,temp); await fs.link(p.original,backup); await fs.unlink(p.original);
  e.returner.update(p.row.id,{state:'working',details:JSON.stringify({...p.row.details,backup,target,temp,hash:await digest(p.input),originalHash:before,phase:'backup'})});
  await e.returner.init(); assert.equal(e.returner.row(p.row.id).state,'attention');
  await e.returner.restore(p.row.id);
  assert.equal(await digest(p.original),before); assert.ok(await fs.stat(p.input)); assert.ok(await fs.stat(temp));
});

test('unsupported hardlinks fail before touching original and retain recoverable copy',async t => {
  const e = await setup(t), p = await pair(e), before = await digest(p.original);
  t.mock.method(fs,'link',async () => { throw Object.assign(new Error('Operation not supported'),{code:'ENOTSUP'}); });
  const row = await move(e,p.row); assert.equal(row.state,'attention');
  assert.equal(await digest(p.original),before); assert.ok(await fs.stat(p.input));
  assert.equal(await digest(row.details.temp),await digest(p.input));
});

test('failure publishing replacement can be recovered without losing input or original',async t => {
  const e = await setup(t), p = await pair(e), before = await digest(p.original), link = fs.link;
  t.mock.method(fs,'link',async (src,dest) => { if (dest.endsWith('Film.2026.mkv')) throw new Error('Simulated publish failure'); return link(src,dest); });
  const row = await move(e,p.row); assert.equal(row.state,'attention');
  assert.equal(await digest(row.details.backup),before); assert.ok(await fs.stat(p.input));
  await e.returner.restore(row.id); assert.equal(await digest(p.original),before);
});

test('OLD deletion verifies replacement contents and rejects changed files and symlinks',async t => {
  const e = await setup(t), p = await pair(e), row = await move(e,p.row);
  await fs.appendFile(row.details.target,'changed');
  await assert.rejects(e.returner.deleteOld([row.id],'SLET OLD'),/ændret/);
  assert.ok(await fs.stat(row.details.backup));
  await fs.unlink(row.details.target); await fs.symlink(row.details.backup,row.details.target);
  await assert.rejects(e.returner.deleteOld([row.id],'SLET OLD'),/Symlinks/);
  assert.ok(await fs.stat(row.details.backup));
});

test('paths outside configured roots and symlink escapes cannot be configured or scanned',async t => {
  const e = await setup(t), outside = path.join(e.root,'outside'); await fs.mkdir(outside);
  await fs.symlink(outside,path.join(e.incoming,'escape'));
  for (const from of [outside,path.join(e.incoming,'escape'),e.media,e.c.configDir]) await assert.rejects(e.returner.setOptions({automatic:false,from,to:e.media}));
  await fs.writeFile(path.join(outside,'Film.2026.mkv'),'secret');
  await e.returner.setOptions({automatic:false,from:e.incoming,to:e.media}); await e.returner.scan();
  assert.equal(e.returner.list().length,0);
});

test('HTTP return routes share authentication and CSRF protection and serve the new UI',async t => {
  const e = await setup(t);
  const c = {...e.c,configDir:path.join(e.root,'api-config'),username:'tester',password:'secret'};
  const s = await createService(c,{background:false}); t.after(()=>s.close());
  await new Promise(resolve=>s.server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:'+s.server.address().port;
  assert.equal((await fetch(origin+'/api/returns')).status,401);
  const auth = {Authorization:'Basic '+Buffer.from('tester:secret').toString('base64')};
  for (const url of ['/returns','/returns.js','/api/returns']) assert.equal((await fetch(origin+url,{headers:auth})).status,200);
  const request = {method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}'};
  assert.equal((await fetch(origin+'/api/returns/move',request)).status,403);
  request.headers['X-ReelShrink'] = '1'; request.headers.Origin = 'https://foreign.invalid';
  assert.equal((await fetch(origin+'/api/returns/delete-old',request)).status,403);
  delete request.headers.Origin;
  assert.equal((await fetch(origin+'/api/returns/delete-old',request)).status,400);
  const status = await (await fetch(origin+'/api/returns',{headers:auth})).json(); assert.equal(status.options.automatic,false);
});

test('real Engine output with embedded SRT is discovered from its database and returned',async t => {
  const e = await setup(t), original = path.join(e.media,'Actual.2026.mp4');
  await clip(e,original);
  await fs.writeFile(original.replace('.mp4','.da.srt'),'1\n00:00:00,000 --> 00:00:00,700\nRødgrød\n');
  const before = await digest(original);
  e.store.addWatch('Actual',e.media,settings({codec:'h264',onlySmaller:false,preset:'fast'}));
  await e.engine.scan(); await sleep(15); await e.engine.scan(); e.engine.tick(); await e.engine.workerPromise;
  const job = e.store.job(e.store.get('SELECT id FROM jobs').id);
  assert.equal(job.state,'completed',job.error);
  assert.equal(job.output_sha256,await digest(job.output));
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(job.output),'reelshrink.json'),'utf8'));
  assert.equal(manifest.sourceSignature,job.signature); assert.equal(manifest.outputSha256,job.output_sha256);
  await e.returner.scan(); await sleep(15); await e.returner.scan();
  const row = await move(e,e.returner.list()[0]); assert.equal(row.state,'done',row.error);
  assert.equal(await digest(row.details.backup),before);
  assert.equal(await digest(row.details.target),job.output_sha256);
  await e.engine.scan(); await sleep(15); await e.engine.scan(); assert.equal(e.store.all('SELECT id FROM jobs').length,1);
});

test('source changes, tampered output hash, insufficient destination space and active encoding block replacement',async t => {
  for (const kind of ['signature','hash','space','active']) await t.test(kind,async t => {
    const e = await setup(t), p = await pair(e), before = await digest(p.original);
    if (kind === 'signature') await fs.writeFile(p.original.replace('.mp4','.en.srt'),'new subtitle');
    if (kind === 'hash') e.store.updateJob(p.id,{output_sha256:'invalid'});
    if (kind === 'space') e.c.minFreeBytes = Number.MAX_SAFE_INTEGER;
    if (kind === 'active') e.engine.active = {id:p.id,controller:new AbortController()};
    const row = await move(e,p.row); assert.equal(row.state,'failed',row.error);
    assert.equal(await digest(p.original),before); assert.ok(await fs.stat(p.input));
    e.engine.active = null;
  });
});

test('disabling automatic mode cancels pending automatic returns even during an active transfer',async t => {
  const e = await setup(t), p = await pair(e);
  e.returner.update(p.row.id,{state:'queued'}); e.returner.active = 'test-active';
  await e.returner.setOptions({automatic:false,from:'',to:''});
  assert.equal(e.returner.row(p.row.id).state,'ready'); assert.equal(e.returner.options().automatic,false);
  e.returner.active = null;
});

test('mapping changes invalidate generic proposals and returned receipts survive a database restart',async t => {
  const e = await setup(t), p = await pair(e,{job:false});
  await e.returner.setOptions({automatic:false,from:'',to:''});
  assert.equal(e.returner.row(p.row.id),null);
  await e.returner.setOptions({automatic:false,from:e.incoming,to:e.media});
  await e.returner.scan(); await sleep(15); await e.returner.scan();
  const row = await move(e,e.returner.list()[0]); assert.equal(row.state,'done',row.error);
  const reopened = new Store(e.c.configDir);
  assert.equal(reopened.get('SELECT stamp FROM returned_files WHERE path=?',row.details.target).stamp,await fingerprint(row.details.target));
  reopened.close();
});
