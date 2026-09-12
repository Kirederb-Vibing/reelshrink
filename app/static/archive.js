'use strict';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=n=>{if(!n)return '0 B';const i=Math.min(4,Math.floor(Math.log(n)/Math.log(1024)));return(n/1024**i).toFixed(i?1:0)+' '+['B','KiB','MiB','GiB','TiB'][i];};
let status={items:[]},library={items:[],counts:{},progress:{}},downloads=new Set(),uploads=new Set(),unsafeUploads=new Set(),sending=[],libraryOffset=0,filtersLoaded=false,flowLoaded=false,busy=false,refreshing=false;
async function api(url,method='GET',data){const res=await fetch(url,{method,headers:{'Content-Type':'application/json','X-ReelShrink':'1'},...(data===undefined?{}:{body:JSON.stringify(data)})});const value=await res.json();if(!res.ok)throw new Error(value.error||'Forespørgslen fejlede.');return value;}
function error(e){$('error').textContent=e.message;$('error').hidden=false;}
async function action(fn){busy=true;try{$('error').hidden=true;await fn();}catch(e){error(e);}finally{busy=false;syncButtons();}}
function libraryParams(){return new URLSearchParams({state:$('library-filter').value,q:$('library-search').value,limit:$('library-page-size').value,offset:String(libraryOffset)});}
function loadFilters(f){$('min-size').value=f.minSizeGB;$('max-size').value=f.maxSizeGB;$('min-duration').value=f.minDurationMinutes;$('min-height').value=f.minSourceHeight;$('skip-hevc').checked=f.skipCodecs.includes('hevc');$('skip-av1').checked=f.skipCodecs.includes('av1');$('skip-h264').checked=f.skipCodecs.includes('h264');filtersLoaded=true;}
function scanSettings(){return{minSizeGB:Number($('min-size').value),maxSizeGB:Number($('max-size').value),minDurationMinutes:Number($('min-duration').value),minSourceHeight:Number($('min-height').value),skipCodecs:['hevc','av1','h264'].filter(c=>$('skip-'+c).checked)};}
function workItems(){const q=$('work-search').value.toLowerCase(),filter=$('work-filter').value;return status.items.filter(r=>(filter==='all'||filter==='ready'&&r.state==='ready'||filter==='pending'&&(!['sent','cleaned'].includes(r.state)||(r.data.workOld&&!r.data.oldApproved)))&&(r.source+' '+r.local_source).toLowerCase().includes(q));}
function syncButtons(){
  $('download-count').textContent=downloads.size+' valgt (maks. 100)';$('upload-count').textContent=uploads.size+' valgt'+(unsafeUploads.size?' · '+unsafeUploads.size+' usikre':'');
  $('download').disabled=busy||!downloads.size||library.scanning;$('upload').disabled=busy||!status.items.some(r=>uploads.has(r.id)&&r.canSend);$('remove-work').disabled=busy||!uploads.size;
  const possible=library.items.filter(r=>r.state==='eligible'&&!r.imported);$('select-library').checked=possible.length>0&&possible.every(r=>downloads.has(r.path));$('select-library').indeterminate=possible.some(r=>downloads.has(r.path))&&!$('select-library').checked;
  const work=workItems();$('select-work').checked=work.length>0&&work.every(r=>uploads.has(r.id));$('select-work').indeterminate=work.some(r=>uploads.has(r.id))&&!$('select-work').checked;
}
function renderLibrary(){
  for(const p of downloads)if(!library.items.some(r=>r.path===p&&r.state==='eligible'&&!r.imported))downloads.delete(p);
  $('found-count').textContent=Object.values(library.counts).reduce((a,n)=>a+n,0);$('eligible-count').textContent=library.counts.eligible||0;$('skipped-count').textContent=library.counts.skipped||0;$('scan-error-count').textContent=library.counts.error||0;
  $('scan-time').textContent=library.lastScan?'Senest '+new Date(library.lastScan).toLocaleString('da-DK'):'Afventer scanning';$('scan-state').textContent=library.scanning?'SCANNER':'KLAR';$('scan-library').disabled=busy||library.scanning;$('save-and-scan').disabled=busy||library.scanning;
  const p=library.progress||{},active=Boolean(library.scanning);$('scan-progress-wrap').hidden=!active;$('scan-progress-text').textContent=active?`${p.drive||'Starter…'} · ${p.checked||0} kontrolleret · ${p.eligible||0} mulige`:'';
  $('library-list').innerHTML=library.items.map(r=>`<article class="return-row"><div class="return-file"><input class="job-checkbox" type="checkbox" data-library="${esc(r.path)}" ${downloads.has(r.path)?'checked':''} ${r.state==='eligible'&&!r.imported?'':'disabled'}><div><strong>${esc(r.relative)}</strong><span class="badge ${r.state==='eligible'?'completed':r.state==='error'?'failed':'skipped'}">${r.state==='eligible'?'Inden for filtre':r.state==='error'?'Scanfejl':'Sprunget over'}</span><p class="hint">${bytes(r.size)}${r.duration!=null?' · '+(r.duration/60).toFixed(1)+' min':''}${r.height?' · '+r.height+'p':''}${r.codec?' · '+esc(r.codec.toUpperCase()):''}${r.imported?' · Allerede hentet / i historik':''}</p><div class="return-paths"><span>Sti</span><code>${esc(r.path)}</code></div>${r.reason?`<p class="hint skip-reason">${esc(r.reason)}</p>`:''}</div></div></article>`).join('')||'<div class="empty"><h2>Ingen filer i denne visning</h2><p>Kør en scanning, eller justér filtre og søgning.</p></div>';
  const limit=library.limit==='all'?Math.max(1,library.total):Number(library.limit);$('library-pagination').hidden=library.total<=limit;$('library-previous').disabled=!libraryOffset;$('library-next').disabled=libraryOffset+limit>=library.total;$('library-page-info').textContent=`${library.total?libraryOffset+1:0}–${Math.min(libraryOffset+limit,library.total)} af ${library.total}`;syncButtons();
}
function renderWork(){
  const existing=new Set(status.items.map(r=>r.id));for(const id of uploads)if(!existing.has(id))uploads.delete(id);
  $('work-list').innerHTML=workItems().map(r=>{const d=r.data,percent=d.total?Math.min(100,100*d.bytes/d.total):0;
  return `<article class="archive-item"><div class="archive-row"><label class="check"><input type="checkbox" data-work="${esc(r.id)}" ${uploads.has(r.id)?'checked':''}><strong>${esc(r.local_source.split('/').slice(-2,-1)[0])}</strong></label><span class="tag">${esc(d.phase)}</span></div><p class="archive-path">Oprindelig placering: ${esc(d.browserOnly?'Browserupload – ingen destination valgt':r.source)}</p>${d.workOld&&!d.oldApproved?`<p class="alert">WORK_OLD bevaret: ${esc(d.workOld)}</p>`:''}${d.timings?`<p class="hint">${Object.entries(d.timings).map(([k,v])=>({downloadMs:'Hentning',encodingMs:'Encoding',checkMs:'Kontrol',uploadMs:'Afsendelse'}[k]||k)+': '+(v/1000).toFixed(1)+' s').join(' · ')}</p>`:''}<p class="archive-path muted">Work: ${esc(r.local_source)}</p>${d.result?`<p class="archive-path">Resultat: ${esc(d.result)}</p>`:''}${['queued_download','downloading','receiving','queued_upload','uploading'].includes(r.state)?`<label class="archive-progress">${esc(d.phase)}<progress max="100" value="${percent.toFixed(1)}"></progress><span>${percent.toFixed(1)} % · ${bytes(d.bytes)} / ${bytes(d.total)}</span></label>`:''}${d.error?`<p class="alert">${esc(d.error)}</p>`:''}<div class="actions">${(['failed_download','attention'].includes(r.state)||(r.state==='local'&&d.error))?`<button class="button small secondary" data-retry="${esc(r.id)}">Prøv igen</button>`:''}${r.state==='local'?`<button class="button small secondary" data-rename="${esc(r.id)}">Omdøb Work-mappe</button>`:''}${d.browserUpload&&['local','ready'].includes(r.state)?`<button class="button small secondary" data-destination="${esc(r.id)}">Vælg destination</button>`:''}${r.canDownload?`<a class="button small secondary" href="/api/archive/${esc(r.id)}/file">Download resultat</a>`:''}<button class="button small danger" data-remove="${esc(r.id)}">Fjern fra Work</button></div></article>`;
  }).join('')||'<p class="loading">Work er tom.</p>';syncButtons();
}
async function refresh(){if(refreshing)return;refreshing=true;try{[status,library]=await Promise.all([api('/api/archive'),api('/api/archive/library?'+libraryParams())]);$('connection').textContent=status.active?'Overfører…':library.scanning?'Scanner…':'Forbundet';$('connection').className='connection ok';$('mode-note').textContent=status.enabled?'Kun valgte filer overføres mellem biblioteksdrevene og Work Library.':'Arbejdsarkiv er ikke aktiveret. Angiv WORK_ROOT i Compose.';$('work-root').textContent=status.workRoot||'';if(!filtersLoaded)loadFilters(library.filters);renderFlow();if(library.scanError)error(new Error(library.scanError));renderLibrary();renderWork();}catch(e){$('connection').textContent='Forbindelse afbrudt';error(e);}finally{refreshing=false;}}
for(const id of ['library-filter','library-page-size'])$(id).onchange=()=>{libraryOffset=0;downloads.clear();refresh();};$('library-search').oninput=()=>{libraryOffset=0;downloads.clear();refresh();};
$('library-previous').onclick=()=>{const n=Number($('library-page-size').value);libraryOffset=Math.max(0,libraryOffset-(Number.isFinite(n)?n:0));refresh();};$('library-next').onclick=()=>{const n=Number($('library-page-size').value);libraryOffset+=Number.isFinite(n)?n:0;refresh();};
$('scan-library').onclick=()=>action(async()=>{await api('/api/archive/library/scan','POST',{});await refresh();});$('scan-form').onsubmit=e=>{e.preventDefault();action(async()=>{await api('/api/archive/library/settings','PUT',scanSettings());await api('/api/archive/library/scan','POST',{});libraryOffset=0;downloads.clear();await refresh();});};
$('library-list').onchange=e=>{const p=e.target.dataset.library;if(!p)return;if(e.target.checked&&downloads.size<100)downloads.add(p);else{downloads.delete(p);e.target.checked=false;}syncButtons();};$('select-library').onchange=e=>{if(e.target.checked)for(const r of library.items.filter(r=>r.state==='eligible'&&!r.imported)){if(downloads.size>=100)break;downloads.add(r.path);}else downloads.clear();renderLibrary();};
$('download').onclick=()=>action(async()=>{await api('/api/archive/download','POST',{paths:[...downloads]});downloads.clear();await refresh();});

$('work-search').oninput=renderWork;$('work-filter').onchange=renderWork;
$('work-list').onchange=e=>{const id=e.target.dataset.work;if(!id)return;if(e.target.checked&&uploads.size<100)uploads.add(id);else{uploads.delete(id);e.target.checked=false;}syncButtons();};
$('select-work').onchange=e=>{uploads.clear();if(e.target.checked)for(const r of workItems().slice(0,100))uploads.add(r.id);renderWork();};
async function removeWork(ids){if(!confirm('Slet de valgte lokale Work-filer og resultater permanent? Originalplaceringen røres ikke.'))return;await api('/api/archive/remove','POST',{ids,confirmation:'SLET WORK'});uploads.clear();await refresh();}
$('work-list').onclick=e=>action(async()=>{
 const button=e.target.closest('button');if(!button)return;const d=button.dataset;
 if(d.remove)await removeWork([d.remove]);
 if(d.retry){await api('/api/archive/'+d.retry+'/retry','POST',{});await refresh();}
 if(d.rename){const title=prompt('Ny titel til Work-mappen (sæt encoding på pause først):');if(title){await api('/api/archive/'+d.rename+'/rename','POST',{title});await refresh();}}
 if(d.destination){const destination=prompt('Eksisterende destinationsmappe, fx /media/film/Filmnavn:');if(destination){await api('/api/archive/'+d.destination+'/destination','POST',{path:destination});await refresh();}}
});
$('remove-work').onclick=()=>action(()=>removeWork([...uploads]));
$('stop-import').onclick=()=>action(async()=>{await api('/api/archive/cancel-downloads','POST',{});await refresh();});
$('rescan-work').onclick=()=>action(async()=>{await api('/api/archive/rescan-work','POST',{});await refresh();});
$('upload').onclick=()=>{sending=status.items.filter(r=>uploads.has(r.id)&&r.canSend).map(r=>r.id);$('send-description').textContent=status.items.some(r=>sending.includes(r.id)&&r.data.flowMode==='speedy_risky')?'SPEEDY RISKY: de valgte resultater sendes uden NAS-indholdskontrol. WORK_OLD bliver på Work indtil særskilt godkendelse.':'De valgte kontrollerede resultater sendes tilbage. Originalvideoen erstattes efter checksumkontrol; tilhørende filer bevares.';$('send-paths').textContent=status.items.filter(r=>sending.includes(r.id)).map(r=>r.source).join('\n');$('send-confirmation-label').textContent='Skriv SEND OG ERSTAT';$('send-confirmation').value='';$('send-dialog').showModal();};
$('cancel-send').onclick=()=>$('send-dialog').close();
$('send-form').onsubmit=e=>{e.preventDefault();action(async()=>{await api('/api/archive/upload','POST',{ids:sending,confirmation:$('send-confirmation').value});$('send-dialog').close();uploads.clear();await refresh();});};
let browserRequest=null;
$('browser-upload').onsubmit=e=>{
 e.preventDefault();const file=$('browser-file').files[0];if(!file||browserRequest)return;
 const xhr=new XMLHttpRequest();browserRequest=xhr;
 xhr.open('POST','/api/archive/receive?'+new URLSearchParams({name:file.name,destination:$('browser-destination').value.trim()}));xhr.setRequestHeader('X-ReelShrink','1');xhr.setRequestHeader('Content-Type','application/octet-stream');
 $('abort-upload').hidden=false;$('browser-status').textContent='Uploader…';
 xhr.upload.onprogress=e=>{if(e.lengthComputable){$('browser-progress').value=100*e.loaded/e.total;$('browser-status').textContent=bytes(e.loaded)+' / '+bytes(e.total);}};
 xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300){$('browser-status').textContent='Upload færdig';$('browser-file').value='';}else{try{error(new Error(JSON.parse(xhr.responseText).error));}catch{error(new Error('Upload fejlede.'));}}};
 xhr.onerror=()=>error(new Error('Upload mistede forbindelsen.'));xhr.onabort=()=>$('browser-status').textContent='Upload stoppet';
 xhr.onloadend=()=>{browserRequest=null;$('abort-upload').hidden=true;refresh();};xhr.send(file);
};
$('abort-upload').onclick=()=>browserRequest?.abort();
refresh();setInterval(()=>{if(!document.hidden&&!$('send-dialog').open)refresh();},2500);

function renderFlow(){
 if(!status.flow)return;
 if(!flowLoaded){$('flow-mode').value=status.flow.mode;$('flow-buffer').value=status.flow.buffer;$('flow-auto').checked=status.flow.autoSend;flowLoaded=true;}
 const b=status.batch;$('batch-panel').hidden=!b;for(const id of ['flow-mode','flow-buffer','flow-auto'])$(id).disabled=Boolean(b);
 if(b){$('batch-status').textContent=b.ids.length+' pladser i denne batch · '+b.items.filter(r=>r.state==='sent').length+' afsendt · næste batch er låst';$('batch-files').innerHTML=b.items.map(r=>'<li>'+esc(r.local_source.split('/').pop())+' · '+esc(r.data.phase)+'</li>').join('');$('approve-batch').disabled=busy||!b.canApprove;}
}
$('flow-form').onsubmit=e=>{e.preventDefault();action(async()=>{
 const mode=$('flow-mode').value,autoSend=$('flow-auto').checked;
 if(mode==='speedy_risky'&&!confirm('Aktivér SPEEDY RISKY? NAS-indhold kontrolleres ikke. Behold WORK_OLD indtil du har kontrolleret resultaterne.'))return;
 if(autoSend&&!confirm('De filer du vælger til import, må automatisk erstatte deres originaler efter encodingkontrol?'))return;
 await api('/api/archive/flow','PUT',{mode,buffer:Number($('flow-buffer').value),autoSend,confirmation:mode==='speedy_risky'?'SPEEDY RISKY':undefined});flowLoaded=false;await refresh();
});};
$('approve-batch').onclick=()=>action(async()=>{
 const batchId=status.batch?.id;
 if(prompt('Efter din egen kontrol af resultaterne: skriv SLET WORK_OLD for at slette batchens lokale originaler og åbne næste batch.')!=='SLET WORK_OLD')return;
 await api('/api/archive/approve-batch','POST',{batchId,confirmation:'SLET WORK_OLD'});await refresh();
});
