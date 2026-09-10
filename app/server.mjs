import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { config, mediaPath, inside, processingPath, settings, FILTER_DEFAULTS, filterReason, VERSION } from './config.mjs';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { Returner } from './returner.mjs';
import { Archive, prepareWork } from './archive.mjs';
import { run } from './media.mjs';

const staticDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'static');
function fail(message,status=400) {throw Object.assign(new Error(message),{status});}
function equal(a,b) {const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
async function body(req) {
  if(!req.headers['content-type']?.startsWith('application/json')) fail('Forventede application/json.',415);
  let size=0,parts=[];
  for await(const chunk of req) {size+=chunk.length;if(size>65536)fail('Forespørgslen er for stor.',413);parts.push(chunk);}
  let data;
  try {data=JSON.parse(Buffer.concat(parts).toString()||'{}');} catch {fail('Ugyldig JSON.');}
  if(!data || typeof data!=='object' || Array.isArray(data)) fail('Forventede et JSON-objekt.');
  return data;
}
export async function createService(c,{background=true}={}) {
  await prepareWork(c);
  const encoders=await run(c.ffmpeg,['-hide_banner','-encoders'],{timeout:10000});
  if(!encoders.out.includes('libx265')||!encoders.out.includes('libx264')) throw new Error('FFmpeg skal indeholde libx265 og libx264.');
  await run(c.ffprobe,['-version'],{timeout:10000});
  await fs.mkdir(c.outputRoot,{recursive:true});await fs.mkdir(c.configDir,{recursive:true});
  c.outputRoot=await fs.realpath(c.outputRoot);c.configDir=await fs.realpath(c.configDir);
  if(inside(c.outputRoot,c.configDir)||inside(c.configDir,c.outputRoot)) throw new Error('Output og konfiguration må ikke overlappe.');
  for(const root of c.mediaRoots) {
    let real;try {real=await fs.realpath(root);} catch(e) {if(e.code==='ENOENT')continue;throw e;}
    if(inside(c.outputRoot,real)||inside(real,c.outputRoot)||inside(c.configDir,real)||inside(real,c.configDir)) throw new Error('Monteringerne for input, output og konfiguration må ikke overlappe.');
  }
  for(const root of c.returnInputRoots) {
    const real=await fs.realpath(root).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!real)continue;
    const others=await Promise.all([c.configDir,c.outputRoot,...c.mediaRoots].map(r=>fs.realpath(r).catch(()=>r)));
    if(others.some(other=>inside(real,other)||inside(other,real)))throw new Error('Ekstra fra-mapper overlapper en anden montering.');
  }
  const store=new Store(c.configDir),engine=new Engine(c,store);
  await engine.init();
  const returner=new Returner(c,store,engine);
  const archive=new Archive(c,store,engine,returner);
  await archive.init();
  await returner.init();
  if(background) {engine.start();returner.start();archive.start();}
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control','no-store');
    try {
      const url=new URL(req.url,'http://localhost'),p=url.pathname,method=req.method;
      if(p==='/api/health'&&method==='GET') return json(res,200,{status:'ok',version:VERSION});
      if(c.username) {
        const auth=req.headers.authorization||'';
        let token='';try {if(auth.startsWith('Basic '))token=Buffer.from(auth.slice(6),'base64').toString();}catch{}
        if(!equal(token,c.username+':'+c.password)) {res.setHeader('WWW-Authenticate','Basic realm="ReelShrink", charset="UTF-8"');return json(res,401,{error:'Log ind for at fortsætte.'});}
      }
      if(!['GET','HEAD'].includes(method)) {
        if(req.headers['x-reelshrink']!=='1') fail('Sikkerhedsheader mangler.',403);
        if(req.headers.origin) {
          let origin;try {origin=new URL(req.headers.origin);}catch {fail('Ugyldig origin.',403);}
          if(origin.host!==req.headers.host)fail('Forespørgsler fra andre websites er ikke tilladt.',403);
        }
      }
      const assets={'/archive':['archive.html','text/html'],'/archive.js':['archive.js','text/javascript'],'/':['index.html','text/html'],'/returns':['returns.html','text/html'],'/returns.js':['returns.js','text/javascript'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/favicon.svg':['favicon.svg','image/svg+xml']};
      if(assets[p]&&['GET','HEAD'].includes(method)) {
        const [file,type]=assets[p];const content=await fs.readFile(path.join(staticDir,file));
        res.writeHead(200,{'content-type':type+'; charset=utf-8'});return res.end(method==='HEAD'?undefined:content);
      }
      if(p==='/api/config'&&method==='GET') return json(res,200,{version:VERSION,workRoot:c.workRoot,mediaRoots:c.mediaRoots,outputRoot:c.outputRoot,threads:c.threads,scanInterval:c.scanInterval,stableSeconds:c.stableSeconds,authentication:Boolean(c.username)});
      if(p==='/api/archive'&&method==='GET') return json(res,200,archive.status());
      if(p==='/api/archive/browse'&&method==='GET') return json(res,200,await archive.browse(url.searchParams.get('path')));
      if(p==='/api/archive/download'&&method==='POST') return json(res,202,{ids:await archive.enqueueDownload((await body(req)).paths)});
      if(p==='/api/archive/upload'&&method==='POST') {const data=await body(req);archive.enqueueUpload(data.ids,data.confirmation);return json(res,202,{ok:true});}
      if(p==='/api/archive/cleanup'&&method==='POST') {const data=await body(req);await archive.cleanup(data.ids,data.confirmation);return json(res,200,{ok:true});}
      const archiveMatch=p.match(/^\/api\/archive\/([a-f0-9-]+)\/retry$/);
      if(archiveMatch&&method==='POST') {await body(req);archive.retry(archiveMatch[1]);return json(res,202,{ok:true});}
      if(p==='/api/returns'&&method==='GET') return json(res,200,returner.status());
      if(p==='/api/returns/settings'&&method==='PUT') return json(res,200,await returner.setOptions(await body(req)));
      if(p==='/api/returns/scan'&&method==='POST') {await body(req);returner.scan();return json(res,202,{ok:true});}
      if(p==='/api/returns/move'&&method==='POST') {returner.enqueue((await body(req)).ids);return json(res,202,{ok:true});}
      if(p==='/api/returns/delete-old'&&method==='POST') {const data=await body(req);return json(res,200,await returner.deleteOld(data.ids,data.confirmation));}
      const returnMatch=p.match(/^\/api\/returns\/([a-f0-9-]+)\/(choose|restore|retry)$/);
      if(returnMatch&&method==='POST') {
        const data=await body(req);
        if(returnMatch[2]==='choose') await returner.choose(returnMatch[1],data.original);
        else if(returnMatch[2]==='restore') await returner.restore(returnMatch[1]);
        else returner.retry(returnMatch[1]);
        return json(res,200,{ok:true});
      }
      if(p==='/api/status'&&method==='GET') {
        const counts=Object.fromEntries(store.all('SELECT state,COUNT(*) AS count FROM jobs WHERE hidden=0 GROUP BY state').map(r=>[r.state,r.count]));
        const saved=store.get("SELECT COALESCE(SUM(saved_bytes),0) AS bytes FROM jobs WHERE state='completed' AND hidden=0").bytes;
        const disk=await fs.statfs(c.outputRoot);
        return json(res,200,{paused:store.paused(),scanning:engine.scanning,counts,savedBytes:saved,outputFreeBytes:disk.bavail*disk.bsize,active:engine.active?store.job(engine.active.id):null});
      }
      if(p==='/api/browse'&&method==='GET') {
        const requested=url.searchParams.get('path');
        if(!requested) return json(res,200,{path:null,parent:null,directories:c.mediaRoots.map(root=>({name:root,path:root}))});
        const directory=mediaPath(requested,c);
        if(!(await fs.stat(directory)).isDirectory()) fail('Stien er ikke en mappe.');
        const roots=await Promise.all(c.mediaRoots.map(r=>fs.realpath(r).catch(()=>r)));
        const parent=roots.includes(directory)?null:path.dirname(directory);
        const entries=await fs.readdir(directory,{withFileTypes:true});
        return json(res,200,{path:directory,parent,directories:entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&!e.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name)).map(e=>({name:e.name,path:path.join(directory,e.name)}))});
      }
      if(p==='/api/watches'&&method==='GET') return json(res,200,store.watches());
      if(p==='/api/watches'&&method==='POST') {
        const data=await body(req),name=String(data.name||'').trim();
        if(!name||name.length>60) fail('Navnet skal være mellem 1 og 60 tegn.');
        const directory=mediaPath(data.path,c);
        if(!(await fs.stat(directory)).isDirectory()) fail('Vælg en mappe.');
        if(store.watches().some(w=>inside(directory,w.path)||inside(w.path,directory))) fail('Mappen overlapper en mappe, der allerede overvåges.');
        const watch=store.addWatch(name,directory,settings(data.settings));
        engine.scan();return json(res,201,watch);
      }
      const watchMatch=p.match(/^\/api\/watches\/([a-f0-9-]+)$/);
      if(watchMatch&&method==='PUT') {
        const id=watchMatch[1],watch=store.watch(id);if(!watch)fail('Mappen findes ikke.',404);
        const data=await body(req),name=String(data.name??watch.name).trim();
        if(!name||name.length>60)fail('Navnet skal være mellem 1 og 60 tegn.');
        const enabled=data.enabled??watch.enabled;if(enabled)processingPath(watch.path,c);if(typeof enabled!=='boolean')fail('Ugyldig aktivering.');
        if(data.settings!==undefined&&(!data.settings||typeof data.settings!=='object'||Array.isArray(data.settings)))fail('Ugyldige indstillinger.');
        const options=settings({...watch.settings,...data.settings});
        const apply=data.applyFiltersToQueued??true;
        if(typeof apply!=='boolean')fail('Ugyldigt valg for eksisterende kø.');
        store.db.exec('BEGIN IMMEDIATE');
        try {
          store.run('UPDATE watches SET name=?,settings=?,enabled=? WHERE id=?',name,JSON.stringify(options),Number(enabled),id);
          if(data.settings && apply) {
            const filters=Object.fromEntries(Object.keys(FILTER_DEFAULTS).map(k=>[k,options[k]]));
            for(const row of store.all("SELECT id,settings,input_bytes FROM jobs WHERE watch_id=? AND state='queued' AND hidden=0",id)) {
              const updated={...JSON.parse(row.settings),...filters},reason=filterReason(updated,row.input_bytes);
              store.updateJob(row.id,{settings:JSON.stringify(updated),...(reason?{state:'skipped',error:reason}:{})});
            }
          }
          store.db.exec('COMMIT');
        } catch(error) {store.db.exec('ROLLBACK');throw error;}
        engine.scan();return json(res,200,store.watch(id));
      }
      if(watchMatch&&method==='DELETE') {
        const id=watchMatch[1];if(!store.watch(id))fail('Mappen findes ikke.',404);
        if(store.get("SELECT id FROM jobs WHERE watch_id=? AND state IN ('running','cancel_requested','queued')",id))fail('Annullér først mappens ventende og aktive jobs.',409);
        if(returner.active||returner.scanning||store.get("SELECT r.id FROM returns r JOIN jobs j ON r.input=j.output WHERE j.watch_id=? AND r.state NOT IN ('done','deleted','restored')",id))fail('Afslut først tilbageflytninger for mappen; jobhistorikken bruges til matchning.',409);
        store.db.exec('BEGIN IMMEDIATE');
        try {store.run('DELETE FROM jobs WHERE watch_id=?',id);store.run('DELETE FROM watches WHERE id=?',id);store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}
        return json(res,200,{ok:true});
      }
      if(p==='/api/jobs'&&method==='GET') {
        const state=url.searchParams.get('state')||'all',q=(url.searchParams.get('q')||'').slice(0,150);
        const requested=url.searchParams.get('limit')??'30';
        const limit=requested==='all'?'all':Number(requested);
        const offset=limit==='all'?0:Number(url.searchParams.get('offset')??0);
        if((limit!=='all'&&(!Number.isSafeInteger(limit)||limit<1||limit>500))||!Number.isSafeInteger(offset)||offset<0)fail('Ugyldig side. Brug limit 1–500 eller all.');
        const clauses=['j.hidden=0'],params=[];
        if(state==='active') clauses.push("j.state IN ('queued','running','cancel_requested')");
        else if(state!=='all') {if(!['completed','skipped','failed','cancelled'].includes(state))fail('Ugyldig status.');clauses.push('j.state=?');params.push(state);}
        if(q) {clauses.push('j.relative LIKE ?');params.push('%'+q+'%');}
        const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
        const total=store.get(`SELECT COUNT(*) AS n FROM jobs j ${where}`,...params).n;
        const items=store.all(`SELECT j.*,w.name AS watch_name FROM jobs j JOIN watches w ON w.id=j.watch_id ${where}
          ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'cancel_requested' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,j.created DESC,j.id DESC LIMIT ? OFFSET ?`,...params,limit==='all'?-1:limit,offset)
          .map(j=>{const result=store.parseJob(j);delete result.log;return result;});
        return json(res,200,{items,total,limit,offset});
      }
      const jobMatch=p.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(cancel|retry))?$/);
      if(p==='/api/jobs/remove'&&method==='POST') {
        const data=await body(req);
        return json(res,200,{removed:store.removeJobs(data.ids)});
      }
      if(jobMatch&&method==='DELETE'&&!jobMatch[2]) return json(res,200,{removed:store.removeJobs([jobMatch[1]])});
      if(jobMatch&&method==='GET'&&!jobMatch[2]) {const job=store.job(jobMatch[1]);if(!job)fail('Jobbet findes ikke.',404);return json(res,200,job);}
      if(jobMatch&&method==='POST') {
        await body(req);
        if(jobMatch[2]==='cancel') engine.cancel(jobMatch[1]);
        else if(jobMatch[2]==='retry') await engine.retry(jobMatch[1]);else fail('Ukendt handling.',404);
        return json(res,200,{ok:true});
      }
      if(p==='/api/scan'&&method==='POST') {await body(req);engine.scan();return json(res,202,{ok:true});}
      if(p==='/api/queue'&&method==='POST') {const data=await body(req);if(typeof data.paused!=='boolean')fail('Angiv paused som true eller false.');store.setPaused(data.paused);if(!data.paused)engine.tick();return json(res,200,{paused:store.paused()});}
      fail('Siden findes ikke.',404);
    } catch(error) {
      if(!res.headersSent) json(res,error.status||(error.code==='ENOENT'?404:400),{error:error.message});
      else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  server.maxHeadersCount=50;
  return {server,store,engine,returner,archive,close:async()=>{
    const closed=new Promise(resolve=>server.listening?server.close(resolve):resolve());
    server.closeIdleConnections();await archive.stop();await returner.stop();await engine.stop();await closed;store.close();
  }};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const c=config(),service=await createService(c);
    service.server.listen(c.port,c.host,()=>console.log(`ReelShrink ${VERSION} lytter på ${c.host}:${c.port}`));
    let closing=false;
    for(const signal of ['SIGTERM','SIGINT']) process.on(signal,async()=>{if(closing)return;closing=true;await service.close();process.exit(0);});
    service.server.on('error',error=>{console.error(error.message);process.exitCode=1;service.close();});
  } catch(error) {console.error('ReelShrink kunne ikke starte:',error.message);process.exitCode=1;}
}
