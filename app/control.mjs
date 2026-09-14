// Persistent global stop, separate from the encoding-only queue pause.
export class RunControl {
  constructor(store,engine,archive,returner){Object.assign(this,{store,engine,archive,returner});this.task=null;this.transition=null;this.closing=false;}
  state(){return JSON.parse(this.store.get("SELECT value FROM settings WHERE key='run_control'")?.value||'{"paused":false}');}
  save(state){this.store.run("INSERT OR REPLACE INTO settings VALUES ('run_control',?)",JSON.stringify(state));}
  busy(){return Boolean(this.engine.active||this.engine.scanning||this.archive.active||this.archive.editing||this.archive.forceRemoving||this.archive.libraryScanning||this.returner.active||this.returner.scanning);}
  status(){
    const s=this.state(),busy=this.busy();
    return {...s,phase:this.task?this.transition:!s.paused?'running':busy?'working':s.error?'error':'stopped',
      encodingPaused:this.store.paused(),readyToShutdown:s.paused&&!this.task&&!busy&&!s.error,
      canResume:s.paused&&!this.task&&!busy,
      activities:[this.engine.active&&'Stopper encoding',this.engine.scanning&&'Stopper Work-scanning',this.archive.active&&'Afslutter filoverførsel',this.archive.editing&&'Afslutter Work-handling',this.archive.libraryScanning&&'Stopper biblioteksscanning',this.returner.active&&'Afslutter tilbageflytning',this.returner.scanning&&'Stopper tilbageflytningsscan'].filter(Boolean)};
  }
  requeueInterrupted(){
    const s=this.state(),j=s.resumeJob?this.store.job(s.resumeJob):null;
    if(j&&j.state==='cancelled')this.store.updateJob(j.id,{state:'queued',progress:0,error:'Samlet stop – encoding starter fra begyndelsen ved genoptagelse.',speed:null,eta:null});
  }
  init(){if(this.state().paused){this.requeueInterrupted();this.save({...this.state(),resumeJob:null});}}
  stop(){
    if(this.closing)throw new Error('Servicen er ved at lukke ned.');
    if(this.task)return this.status();
    const old=this.state();if(old.paused&&!old.error&&!this.busy())return this.status();
    const active=this.engine.active&&this.store.job(this.engine.active.id);
    this.save({...old,paused:true,error:null,resumeJob:active?.state==='running'?active.id:old.resumeJob||null,resumeLibrary:old.resumeLibrary||this.archive.libraryScanning});
    this.engine.active?.controller.abort();this.engine.scanController.abort();
    this.archive.libraryScanController.abort();
    // Keep the active import/upload's existing durability and publication logic.
    // Legacy scanning and transfer share a controller: never abort an active transfer.
    if(!this.returner.active)this.returner.controller.abort();
    this.transition='stopping';
    this.task=(async()=>{
      while(this.busy())await new Promise(resolve=>setTimeout(resolve,25));
      this.requeueInterrupted();
      const checkpoint=this.store.get('PRAGMA wal_checkpoint(FULL)');
      if(checkpoint.busy)throw new Error('Databasen er optaget. Prøv Stop alt sikkert igen.');
      this.save({...this.state(),resumeJob:null,error:null});
    })().catch(error=>{this.save({...this.state(),error:error.message});}).finally(()=>{this.task=null;this.transition=null;});
    return this.status();
  }
  resume(){
    if(this.closing||this.task||this.busy())throw new Error('Vent til det samlede stop eller den lokale handling er færdig.');
    const s=this.state();if(!s.paused)return this.status();
    this.transition='resuming';
    this.task=(async()=>{
      this.requeueInterrupted();
      this.engine.scanController=new AbortController();this.archive.libraryScanController=new AbortController();this.archive.controller=new AbortController();this.returner.controller=new AbortController();
      // A restart while stopped defers local completion/recovery until explicit resume.
      if(this.archive.finish){
        this.archive.editing=true;
        try{
          for(const r of this.archive.list().filter(r=>r.state==='local')){
            if(this.closing)return;
            try{await this.archive.finish(r);}catch(error){this.archive.update(r.id,'local',{...this.archive.row(r.id).data,error:error.message});}
          }
        }finally{this.archive.editing=false;}
      }
      if(this.closing)return;
      this.save({paused:false});
      this.engine.scan();this.engine.tick();this.archive.tick();
      if(s.resumeLibrary&&this.archive.c.workRoot)this.archive.scanLibrary();
      if(!this.archive.c.workRoot){this.returner.scan();this.returner.tick();}
    })().catch(error=>{this.save({...this.state(),paused:true,error:error.message});}).finally(()=>{this.task=null;this.transition=null;});
    return this.status();
  }
}
