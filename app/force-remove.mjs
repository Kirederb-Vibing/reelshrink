import fs from 'node:fs/promises';
import path from 'node:path';
import {inside} from './config.mjs';

// Explicit disaster recovery: only current local Work paths are disposable.
// Origin identities and media checksums deliberately do not participate.
export async function forceRemove(archive, kind, ids, confirmation) {
  if(confirmation!=='FORCE SLET')throw new Error('Bekræft med FORCE SLET.');
  archive.enabled();archive.ids(ids);
  const {store,engine,c,returner}=archive;
  if(archive.editing||archive.forceRemoving||returner.active||returner.scanning)throw new Error('En anden Work-handling er i gang. Prøv igen om lidt.');
  const selected=new Set(ids),rows=archive.list(),allJobs=store.all('SELECT * FROM jobs');
  if(!['archive','jobs'].includes(kind))throw new Error('Ugyldigt udvalg.');
  const initial=kind==='archive'?rows.filter(r=>selected.has(r.id)):allJobs.filter(j=>selected.has(j.id));
  if(initial.length!==selected.size)throw new Error('Et valgt emne findes ikke længere. Opdatér listen.');
  const sources=new Set(initial.map(r=>kind==='archive'?r.local_source:r.source));
  const chosen=rows.filter(r=>sources.has(r.local_source)||sources.has(r.source));
  for(const r of chosen)sources.add(r.local_source);
  const chosenIds=new Set(chosen.map(r=>r.id));
  const jobs=allJobs.filter(j=>sources.has(j.source)),jobIds=new Set(jobs.map(j=>j.id));
  if(archive.active&&!chosenIds.has(archive.active)||engine.active&&!jobIds.has(engine.active.id))throw new Error('Vent til det øvrige aktive arbejde er færdigt. Valgte aktive emner kan Force Slettes.');
  archive.forceRemoving=true;archive.editing=true;engine.maintenance=true;
  const skipped=[];
  try {
    if(archive.active){archive.controller.abort();await archive.workerPromise?.catch(()=>{});archive.controller=new AbortController();}
    if(engine.active){engine.active.controller.abort();await engine.workerPromise?.catch(()=>{});}
    engine.scanController.abort();
    while(engine.scanning)await new Promise(r=>setTimeout(r,20));
    // A worker may have published output immediately before it stopped.
    const freshJobs=store.all('SELECT * FROM jobs').filter(j=>sources.has(j.source));
    const freshRows=chosen.map(r=>archive.row(r.id));
    const bundlePaths=j=>{const b=JSON.parse(j.bundle);return [...(b.sidecars||[]),...(b.subtitles||[]).map(s=>s.path)];};
    const paths=new Set([...sources,...freshJobs.flatMap(j=>[j.output,...bundlePaths(j)]).filter(Boolean)]);
    for(const r of freshRows)for(const key of ['result','workOld'])if(r.data[key])paths.add(r.data[key]);
    const journals=store.all('SELECT * FROM returns').filter(r=>paths.has(r.input)||paths.has(r.original)||jobIds.has(JSON.parse(r.details).jobId));
    for(const r of journals){paths.add(r.input);for(const k of ['target','old','temp']){const f=JSON.parse(r.details)[k];if(typeof f==='string')paths.add(f);}}
    const dirs=new Set(),files=new Set();
    const otherPaths=[...rows.filter(r=>!chosenIds.has(r.id)).flatMap(r=>[r.local_source,r.data.result,r.data.workOld]),...allJobs.filter(j=>!jobIds.has(j.id)).flatMap(j=>[j.source,j.output,...bundlePaths(j)])].filter(Boolean);
    for(const f of paths){
      if(typeof f!=='string'||!path.isAbsolute(f))continue;
      const root=[...c.mediaRoots,c.outputRoot,...c.returnInputRoots].find(root=>f!==root&&inside(f,root));
      if(!root){skipped.push(f);continue;}
      const dir=path.dirname(f);
      // Only owned directories; shared folders are cleaned file by file.
      if(dir!==root&&!otherPaths.some(other=>inside(other,dir)))dirs.add(dir);else if(!otherPaths.includes(f))files.add(f);
    }
    for(const r of chosen)dirs.add(path.join(c.workRoot,'.archive-'+r.id));
    for(const j of freshJobs)dirs.add(path.join(engine.stageRoot,j.id));
    // Never follow an ancestor symlink, or recurse across a mounted filesystem.
    async function validate(f){
      if(!inside(f,c.workRoot)||f===c.workRoot)throw new Error('Ugyldig lokal sletningssti.');
      let current=c.workRoot;const rootStat=await fs.lstat(current);
      if(rootStat.isSymbolicLink())throw new Error('Work må ikke være et symlink.');
      for(const part of path.relative(c.workRoot,f).split(path.sep)){
        current=path.join(current,part);let stat;try{stat=await fs.lstat(current);}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return false;throw e;}
        if(stat.isSymbolicLink()){if(current===f)return true;skipped.push(f);return false;}
        if(stat.dev!==rootStat.dev){skipped.push(f);return false;}
      }
      return true;
    }
    async function checkTree(f){const s=await fs.lstat(f);if(s.isDirectory())for(const entry of await fs.readdir(f)){const child=path.join(f,entry);if(!await validate(child))throw new Error('Work-mappen indeholder en separat montering. Intet er slettet: '+child);await checkTree(child);}}
    const deletion=[];
    for(const f of new Set([...dirs,...files]))if(await validate(f)){await checkTree(f);deletion.push(f);}
    for(const f of deletion)await fs.rm(f,{recursive:true,force:true});
    store.db.exec('BEGIN IMMEDIATE');
    try{
      for(const r of journals){store.run('DELETE FROM returned_files WHERE return_id=?',r.id);store.run('DELETE FROM returns WHERE id=?',r.id);}
      for(const f of paths)store.run('DELETE FROM returned_files WHERE path=?',f);
      for(const source of sources)store.run('DELETE FROM jobs WHERE source=?',source);
      for(const r of chosen)store.run('DELETE FROM archive_items WHERE id=?',r.id);
      // Keep the batch gate, but forget removed IDs; no automatic replacement slots.
      const b=archive.batch?.();if(b){b.ids=b.ids.filter(id=>!chosenIds.has(id));archive.saveBatch(b);}
      store.db.exec('COMMIT');
    }catch(e){store.db.exec('ROLLBACK');throw e;}
    engine.seen.clear();returner.seen.clear();
    return {removed:selected.size,skippedPaths:[...new Set(skipped)]};
  }finally{
    engine.scanController=new AbortController();
    engine.maintenance=false;archive.editing=false;archive.forceRemoving=false;
    archive.tick();engine.tick();
  }
}
