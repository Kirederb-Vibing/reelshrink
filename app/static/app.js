const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stateNames={queued:'I kø',running:'Encoder',cancel_requested:'Annullerer',completed:'Færdig',skipped:'Sprunget over',failed:'Fejlet',cancelled:'Annulleret'};
const qualityNames={high:'Høj kvalitet',balanced:'Balanceret',small:'Mindre fil'};
const codecName=c=>c==='hevc'?'H.265':'H.264';
const base=p=>String(p).split('/').pop();
function bytes(n){if(n===null||n===undefined)return '—';if(n===0)return '0 B';const i=Math.min(4,Math.floor(Math.log(Math.max(1,n))/Math.log(1024)));return new Intl.NumberFormat('da-DK',{maximumFractionDigits:i?1:0}).format(n/1024**i)+' '+['B','KiB','MiB','GiB','TiB'][i];}
function duration(n){if(!Number.isFinite(n))return 'Beregner…';if(n<60)return Math.ceil(n)+' sek.';if(n<3600)return Math.ceil(n/60)+' min.';return Math.floor(n/3600)+' t. '+Math.round(n%3600/60)+' min.';}
const rendered=new Map();
function html(id,content){const el=$(id);if(rendered.get(id)===content||el.contains(document.activeElement))return;el.innerHTML=content;rendered.set(id,content);}
function badge(state){return `<span class="badge ${esc(state)}">${esc(stateNames[state]||state)}</span>`;}
async function api(route,method='GET',data){const response=await fetch('/api'+route,{method,headers:{'Content-Type':'application/json','X-ReelShrink':'1'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(20000)});const value=await response.json();if(!response.ok)throw new Error(value.error||'Forespørgslen mislykkedes.');return value;}
const selectedJobs=new Set();
let visibleJobs=[];
const removable=j=>!['running','cancel_requested'].includes(j.state);
const filterFields=[['min-size','minSizeGB'],['max-size','maxSizeGB'],['min-duration','minDurationMinutes'],['min-source-height','minSourceHeight']];
let watches=[],system=null,status=null,offset=0,total=0,refreshing=false,refreshAgain=false,toastTimer,browserState=null,detailId=null;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function error(message){$('connection-error').textContent=message;$('connection-error').hidden=false;}
function confirmAction(title,text){return new Promise(resolve=>{const d=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-text').textContent=text;let accepted=false;$('confirm-yes').onclick=()=>{accepted=true;d.close();};d.addEventListener('close',()=>resolve(accepted),{once:true});d.showModal();});}
function renderActive(){
  const j=status.active;
  if(!j){const noWatches=!watches.length;html('active-panel',`<div class="empty"><span class="large-symbol" aria-hidden="true">${status.paused?'Ⅱ':'▶'}</span><h2>${noWatches?'Klar til din første film':status.paused?'Køen er sat på pause':'Klar til næste fil'}</h2><p>${noWatches?'Vælg en mappe med film eller serier. ReelShrink finder selv videoer og tilhørende undertekster.':status.paused?'Mappeovervågningen fortsætter. Genoptag køen, når encodingen skal starte igen.':'Nye filer bliver automatisk sat i kø, når kopieringen er afsluttet og filerne er stabile.'}</p>${noWatches?'<button class="button primary" data-action="add">+ Tilføj din første mappe</button>':''}</div>`);return;}
  const checking=j.progress>=99;
  html('active-panel',`<div class="active-top"><span class="tag">${checking?'KONTROLLERER RESULTAT':'ENCODER NU'}</span><button class="button small secondary" data-action="cancel" data-id="${esc(j.id)}">Annullér</button></div><div class="active-title"><div class="film-symbol" aria-hidden="true">▶</div><div><h3>${esc(base(j.source))}</h3><p>${esc(j.watch_name)} · ${codecName(j.settings.codec)} · ${esc(qualityNames[j.settings.quality])}</p></div></div><div class="progress-top"><span>${checking?'Kontrollerer hele videoen og alle lydspor':esc(j.info?`${j.info.width} × ${j.info.height} · ${j.info.subtitles} undertekstspor`:'Analyserer kilden…')}</span><strong>${Math.floor(j.progress)}%</strong></div><progress value="${j.progress}" max="100" aria-label="Encoding-fremdrift"></progress><div class="active-bottom"><span>Original <b>${bytes(j.input_bytes)}</b></span><span>Hastighed <b>${esc(j.speed||'—')}</b></span><span>${checking?'Kontrollen kan tage nogle minutter':`Ca. <b>${duration(j.eta)}</b> tilbage`}</span></div>`);
}
function renderWatches(){
  document.body.classList.toggle('work-mode',Boolean(system?.workRoot));
  html('watch-list',watches.length?watches.map(w=>`<article class="watch-item"><div class="watch-top"><strong>${esc(w.name)}</strong><span class="badge ${w.enabled?'completed':''}">${w.enabled?'Aktiv':'Sat på pause'}</span></div><code>${esc(w.path)}</code><p class="watch-meta">${codecName(w.settings.codec)} · ${esc(qualityNames[w.settings.quality])} · ${w.settings.maxHeight?w.settings.maxHeight+'p':'Original opløsning'}<br>${w.waiting?`${w.waiting} fil(er) afventer stabilitet`:w.last_scan?'Senest scannet '+new Date(w.last_scan).toLocaleTimeString('da-DK',{hour:'2-digit',minute:'2-digit'}):'Afventer første scanning'}</p><div class="watch-actions"><button class="button small secondary" data-action="edit-watch" data-id="${esc(w.id)}">Indstillinger</button><button class="text-button" data-action="toggle-watch" data-id="${esc(w.id)}">${w.enabled?'Sæt på pause':'Aktivér'}</button><button class="text-button" data-action="delete-watch" data-id="${esc(w.id)}">Fjern</button></div>${w.scan_error?`<p class="watch-error">${esc(w.scan_error)}</p>`:''}</article>`).join(''):'<div class="empty"><h2>Ingen mapper endnu</h2><p>Tilføj en mappe for at begynde.</p></div>');
}
function syncSelection(){
  const eligible=visibleJobs.filter(removable);
  for(const j of visibleJobs)if(!removable(j))selectedJobs.delete(j.id);
  for(const input of document.querySelectorAll('[data-job-selection]')){
    const job=visibleJobs.find(j=>j.id===input.dataset.jobSelection);
    input.checked=selectedJobs.has(input.dataset.jobSelection);
    input.disabled=!job||!removable(job);
    input.closest('tr').classList.toggle('selected',input.checked);
  }
  const count=eligible.filter(j=>selectedJobs.has(j.id)).length;
  $('select-page').checked=eligible.length>0&&count===eligible.length;
  $('select-page').indeterminate=count>0&&count<eligible.length;
  $('select-page').disabled=!eligible.length;
  $('selection-count').textContent=`${selectedJobs.size} valgt (maks. 100)`;
  $('remove-selected').disabled=!selectedJobs.size;
  $('clear-selection').disabled=!selectedJobs.size;
}
function renderJobs(data){
  visibleJobs=data.items;total=data.total;$('job-count').textContent=total+' filer';
  html('job-list',data.items.length?`<table class="job-table"><thead><tr><th>Fil</th><th>Profil</th><th>Status</th><th>Størrelse / handling</th></tr></thead><tbody>${data.items.map(j=>`<tr class="${selectedJobs.has(j.id)?'selected':''}"><td><div class="job-file"><input type="checkbox" class="job-checkbox" data-job-selection="${esc(j.id)}" aria-label="Vælg ${esc(base(j.source))}" ${selectedJobs.has(j.id)?'checked':''} ${removable(j)?'':'disabled'}><div><button class="file-button" data-action="detail" data-id="${esc(j.id)}">${esc(base(j.source))}</button><small>${esc(j.watch_name)}</small></div></div></td><td>${codecName(j.settings.codec)}<small>${esc(qualityNames[j.settings.quality])}</small></td><td>${badge(j.state)}${j.state==='running'?`<small>${Math.floor(j.progress)}%</small>`:''}${j.state==='skipped'&&j.error?`<small class="skip-reason">${esc(j.error)}</small>`:''}</td><td>${j.state==='completed'?bytes(j.output_bytes):bytes(j.input_bytes)}${j.state==='completed'?`<small class="savings">${j.output_bytes<j.input_bytes?'−':'+'}${Math.abs(Math.round(100*(1-j.output_bytes/j.input_bytes)))}% · ${bytes(j.input_bytes)} før</small>`:''}<button class="text-button remove-job" data-action="remove-job" data-id="${esc(j.id)}" ${removable(j)?'':'disabled title="Annullér jobbet, og vent til det er stoppet"'} aria-label="Fjern ${esc(base(j.source))} fra listen">Fjern</button></td></tr>`).join('')}</tbody></table>`:`<div class="empty"><h2>${$('search').value||$('filter').value!=='all'?'Ingen match':'Køen er tom'}</h2><p>${$('search').value||$('filter').value!=='all'?'Prøv et andet søgeord eller en anden status.':'Dine film og episoder vises her, når de er fundet og klar til encoding.'}</p></div>`);
  syncSelection();
  const all=data.limit==='all',size=all?total:data.limit;
  $('pagination').hidden=all||total<=size;$('previous').disabled=offset===0;$('next').disabled=all||offset+size>=total;$('page-info').textContent=total?`${offset+1}–${Math.min(offset+size,total)} af ${total}`:'0 filer';
  $('all-jobs-note').hidden=!all;
}
async function removeJobs(ids){
  if(!ids.length)return;
  if(!await confirmAction(ids.length===1?'Fjern jobbet fra listen?':`Fjern ${ids.length} valgte jobs?`,'Originaler og færdige filer bevares. Ventende jobs tages ud af køen. Uændrede filer sættes ikke automatisk i kø igen ved næste scanning.'))return;
  await api('/jobs/remove','POST',{ids});
  for(const id of ids)selectedJobs.delete(id);
  if(ids.includes(detailId))$('job-dialog').close();
  document.activeElement?.blur();rendered.delete('job-list');
  toast(`${ids.length} job(s) fjernet fra listen. Mediefilerne er bevaret.`);
  await refresh();
}
async function refresh(){
  if(refreshing){refreshAgain=true;return;}refreshing=true;
  try{
    const pageSize=$('page-size').value;
    const params=new URLSearchParams({state:$('filter').value,q:$('search').value,offset:String(offset),limit:pageSize});
    const values=await Promise.all([api('/status'),api('/watches'),api('/jobs?'+params),system?Promise.resolve(system):api('/config')]);
    if(pageSize!==$('page-size').value)return;
    if(pageSize!=='all'&&values[2].total>0&&offset>=values[2].total){offset=Math.floor((values[2].total-1)/Number(pageSize))*Number(pageSize);params.set('offset',String(offset));values[2]=await api('/jobs?'+params);}
    if(pageSize!==$('page-size').value)return;
    if(!values[2].total||pageSize==='all')offset=0;
    [status,watches,,system]=values;
    $('connection-error').hidden=true;$('connection').textContent=status.scanning?'Scanner mapper…':status.paused?'Kø på pause':'Forbundet';$('connection').className='connection ok';
    $('version').textContent=system.version;$('pause').disabled=false;$('pause').textContent=status.paused?'Genoptag kø':'Sæt kø på pause';
    $('saved').textContent=bytes(status.savedBytes);$('queued').textContent=status.counts.queued||0;$('completed').textContent=status.counts.completed||0;$('free').textContent=bytes(status.outputFreeBytes);$('output-root').textContent=system.outputRoot;
    $('engine-info').textContent=`${system.workRoot?'Kun lokalt arbejdsarkiv · ':''}CPU-encoding · ${system.threads} tråde · MKV\nScan hvert ${system.scanInterval}. sekund`;
    renderActive();renderWatches();renderJobs(values[2]);
    if(detailId&&$('job-dialog').open)renderDetail(await api('/jobs/'+detailId));
  }catch(e){$('connection').textContent='Ingen forbindelse';$('connection').className='connection offline';error('Kunne ikke opdatere overblikket: '+e.message);}
  finally{refreshing=false;if(refreshAgain){refreshAgain=false;queueMicrotask(refresh);}}
}
function openWatch(id){
  const w=watches.find(w=>w.id===id);$('watch-form').reset();$('watch-id').value=id||'';$('watch-name').value=w?.name||'';$('watch-path').value=w?.path||'';$('watch-path').readOnly=Boolean(w);$('browse-toggle').disabled=Boolean(w);
  $('watch-dialog-title').textContent=w?'Mappeindstillinger':'Tilføj en mappe';$('watch-save').textContent=w?'Gem indstillinger':'Start overvågning';$('settings-note').hidden=!w;$('apply-filters-label').hidden=!w;
  if(w){const s=w.settings;for(const [id,key]of [['codec','codec'],['quality','quality'],['preset','preset'],['height','maxHeight'],['audio','audio']])$(id).value=s[key];$('smaller').checked=s.onlySmaller;$('sidecars').checked=s.copySidecars;}
  for(const [id,key]of filterFields)$(id).value=w?.settings[key]??0;
  for(const codec of ['hevc','av1','h264'])$('skip-'+codec).checked=w?.settings.skipCodecs?.includes(codec)||false;
  $('allow-hdr').checked=w?.settings.allowHDR||false;$('allow-atmos').checked=w?.settings.allowAtmosLoss||false;$('watch-error').hidden=true;$('browser').hidden=true;$('watch-dialog').showModal();
}
async function browse(directory){
  browserState=await api('/browse'+(directory?'?path='+encodeURIComponent(directory):''));$('browse-path').textContent=browserState.path||'Mediemapper';$('browse-up').disabled=!browserState.path;$('browse-select').disabled=!browserState.path;
  html('browse-list',browserState.directories.map(d=>`<button type="button" class="folder-button" data-action="folder" data-path="${esc(d.path)}">${esc(d.name)}</button>`).join('')||'<p class="hint">Ingen undermapper.</p>');
  $('browser').hidden=false;
}
function renderDetail(j){
  const s=j.settings,info=j.info;
  html('job-detail',`<h3>${esc(base(j.source))}</h3><p class="hint">${esc(j.watch_name)} · ${new Date(j.created).toLocaleString('da-DK')}</p>${badge(j.state)}${j.error?`<div class="alert">${esc(j.error)}</div>`:''}<dl class="detail-grid"><div><dt>Profil</dt><dd>${codecName(s.codec)} · ${esc(qualityNames[s.quality])}</dd></div><div><dt>Opløsning</dt><dd>${info?`${info.width} × ${info.height}`:'Afventer analyse'}${s.maxHeight?` → maks. ${s.maxHeight}p`:''}</dd></div><div><dt>Original</dt><dd>${bytes(j.input_bytes)}</dd></div><div><dt>${j.state==='completed'?'Gemt resultat':'Beregnede outputstørrelse'}</dt><dd>${bytes(j.output_bytes)}</dd></div><div><dt>Lydspor</dt><dd>${info?info.audio:'—'} · ${s.audio==='copy'?'Bevares':'AAC stereo'}</dd></div><div><dt>Valgbare undertekstspor</dt><dd>${info?info.subtitles:'Afventer analyse'}</dd></div></dl><p class="detail-label">Kilde</p><code class="path-block">${esc(j.source)}</code>${j.state==='completed'&&j.output?`<p class="detail-label">Resultat</p><code class="path-block">${esc(j.returned_output||j.output)}</code>`:''}<p class="detail-label">Fundne eksterne undertekster</p><code class="path-block">${j.bundle.subtitles.length?j.bundle.subtitles.map(x=>esc(base(x.path))+' · '+esc(x.language)).join('\n'):'Ingen eksterne SRT-filer'}</code>${j.log?`<details><summary>Vis FFmpeg-log</summary><pre class="log">${esc(j.log)}</pre></details>`:''}<div class="actions">${['queued','failed','skipped','cancelled'].includes(j.state)?`<button class="button secondary" data-action="override" data-id="${esc(j.id)}">HDR / Atmos for denne fil</button>`:''}${['queued','running','cancel_requested'].includes(j.state)?`<button class="button secondary" data-action="cancel" data-id="${esc(j.id)}">Annullér job</button>`:''}${removable(j)?`<button class="button danger" data-action="remove-job" data-id="${esc(j.id)}">Fjern fra listen</button>`:''}${['failed','skipped','cancelled'].includes(j.state)?`<button class="button primary" data-action="retry" data-id="${esc(j.id)}">Prøv igen med mappens aktuelle profil</button>`:''}</div>`);
}
document.addEventListener('click',async(event)=>{
  const close=event.target.closest('[data-close]');if(close){$(close.dataset.close).close();return;}
  const button=event.target.closest('[data-action]');if(!button)return;const {action,id,path}=button.dataset;
  try{
    if(action==='add')openWatch();
    else if(action==='edit-watch')openWatch(id);
    else if(action==='folder')await browse(path);
    else if(action==='detail'){detailId=id;renderDetail(await api('/jobs/'+id));$('job-dialog').showModal();}
    else if(action==='toggle-watch'){const w=watches.find(w=>w.id===id);await api('/watches/'+id,'PUT',{enabled:!w.enabled});toast(w.enabled?'Mappe sat på pause. Et igangværende job færdiggøres.':'Overvågning aktiveret.');await refresh();}
    else if(action==='delete-watch'){if(await confirmAction('Fjern overvågningsmappe?','Mappen fjernes fra overvågning, og dens jobhistorik slettes. Originaler og færdige filer bevares.')){await api('/watches/'+id,'DELETE');toast('Overvågningsmappe fjernet.');await refresh();}}
    else if(action==='cancel'){if(await confirmAction('Annullér dette job?','Den midlertidige encoding slettes. Originalen bevares, og jobbet kan genstartes.')){await api('/jobs/'+id+'/cancel','POST',{});toast('Jobbet annulleres.');await refresh();}}
    else if(action==='remove-job')await removeJobs([id]);
    else if(action==='override'){const j=await api('/jobs/'+id);$('override-id').value=id;$('file-hdr').checked=j.settings.allowHDR||false;$('file-atmos').checked=j.settings.allowAtmosLoss||false;$('override-dialog').showModal();}
    else if(action==='retry'){const j=await api('/jobs/'+id);await api('/jobs/'+id+'/retry','POST',{overrides:{allowHDR:j.settings.allowHDR||false,allowAtmosLoss:j.settings.allowAtmosLoss||false}});toast('Jobbet er sat i kø igen.');await refresh();}
  }catch(e){if($('watch-dialog').open){$('watch-error').textContent=e.message;$('watch-error').hidden=false;}else toast(e.message);}
});
$('watch-form').addEventListener('submit',async event=>{
  event.preventDefault();$('watch-save').disabled=true;$('watch-error').hidden=true;
  try{
    const id=$('watch-id').value,data={name:$('watch-name').value,path:$('watch-path').value,settings:{codec:$('codec').value,quality:$('quality').value,preset:$('preset').value,maxHeight:Number($('height').value),audio:$('audio').value,onlySmaller:$('smaller').checked,copySidecars:$('sidecars').checked,allowHDR:$('allow-hdr').checked,allowAtmosLoss:$('allow-atmos').checked}};
    Object.assign(data.settings,Object.fromEntries(filterFields.map(([id,key])=>[key,Number($(id).value)])),{skipCodecs:['hevc','av1','h264'].filter(codec=>$('skip-'+codec).checked)});
    data.applyFiltersToQueued=$('apply-filters').checked;
    await api('/watches'+(id?'/'+id:''),id?'PUT':'POST',data);$('watch-dialog').close();toast(id?'Indstillinger gemt.':'Overvågning startet. Filer afventer først stabilitet.');await refresh();
  }catch(e){$('watch-error').textContent=e.message;$('watch-error').hidden=false;}finally{$('watch-save').disabled=false;}
});
$('browse-toggle').onclick=async()=>{try{await browse();}catch(e){$('watch-error').textContent=e.message;$('watch-error').hidden=false;}};
$('browse-up').onclick=()=>browse(browserState?.parent).catch(e=>toast(e.message));
$('browse-select').onclick=()=>{if(browserState?.path){$('watch-path').value=browserState.path;$('browser').hidden=true;}};
$('job-dialog').addEventListener('close',()=>detailId=null);
$('pause').onclick=async()=>{try{const paused=!status.paused;await api('/queue','POST',{paused});toast(paused?'Køen er sat på pause. Det aktive job færdiggøres.':'Køen er genoptaget.');await refresh();}catch(e){toast(e.message);}};
$('scan').onclick=async()=>{try{await api('/scan','POST',{});toast('Scanning startet. Filer kontrolleres stadig for stabilitet.');await refresh();}catch(e){toast(e.message);}};
$('filter').onchange=()=>{selectedJobs.clear();syncSelection();offset=0;refresh();};let searchTimer;$('search').oninput=()=>{clearTimeout(searchTimer);selectedJobs.clear();syncSelection();searchTimer=setTimeout(()=>{offset=0;refresh();},300);};
$('page-size').onchange=()=>{offset=0;try{localStorage.setItem('reelshrink.pageSize',$('page-size').value);}catch{}refresh();};
$('previous').onclick=()=>{offset=Math.max(0,offset-Number($('page-size').value));refresh();};$('next').onclick=()=>{offset+=Number($('page-size').value);refresh();};
try{const saved=localStorage.getItem('reelshrink.pageSize');if(['30','50','100','200','500','all'].includes(saved))$('page-size').value=saved;}catch{}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
refresh();setInterval(()=>{if(!document.hidden)refresh();},2500);

document.addEventListener('change',event=>{
  const input=event.target.closest('[data-job-selection]');if(!input)return;
  if(input.checked&&selectedJobs.size>=100){input.checked=false;toast('Du kan vælge op til 100 jobs ad gangen.');return;}
  if(input.checked)selectedJobs.add(input.dataset.jobSelection);else selectedJobs.delete(input.dataset.jobSelection);
  syncSelection();
});
$('select-page').onchange=()=>{
  const eligible=visibleJobs.filter(removable),checked=$('select-page').checked;
  if(checked&&new Set([...selectedJobs,...eligible.map(j=>j.id)]).size>100){toast('Du kan vælge op til 100 jobs ad gangen.');syncSelection();return;}
  for(const j of eligible)if(checked)selectedJobs.add(j.id);else selectedJobs.delete(j.id);
  syncSelection();
};
$('clear-selection').onclick=()=>{selectedJobs.clear();syncSelection();};
$('remove-selected').onclick=async()=>{try{await removeJobs([...selectedJobs]);}catch(e){toast(e.message);await refresh();}};

$('override-form').onsubmit=async e=>{e.preventDefault();try{await api('/jobs/'+$('override-id').value,'PUT',{allowHDR:$('file-hdr').checked,allowAtmosLoss:$('file-atmos').checked});$('override-dialog').close();toast('Filens override er gemt.');await refresh();}catch(e){toast(e.message);}};
