'use strict';
(()=>{
  const panel=document.createElement('section');panel.className='panel';panel.setAttribute('aria-label','Samlet processtyring');
  panel.innerHTML='<div class="heading"><div><h2>Samlet processtyring</h2><p data-state role="status" aria-live="polite">Henter status…</p><p class="hint">Stop afbryder encoding og scanning. Aktuelle filoverførsler afsluttes; nye opgaver venter. Encoding starter fra begyndelsen ved genoptagelse.</p></div><div class="actions"><button data-stop class="button danger" disabled>Stop alt sikkert</button><button data-resume class="button primary" disabled>Genoptag alt</button></div></div><p data-error class="alert" hidden></p>';
  document.querySelector('main').prepend(panel);
  const state=panel.querySelector('[data-state]'),error=panel.querySelector('[data-error]'),stop=panel.querySelector('[data-stop]'),resume=panel.querySelector('[data-resume]');let busy=false;
  async function api(route,method='GET'){
    const r=await fetch('/api/control'+route,{method,headers:{'X-ReelShrink':'1','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(15000)});
  window.reelShrinkCheckAuth?.(r);
    const data=await r.json();if(!r.ok)throw new Error(data.error||'Forespørgslen fejlede.');return data;
  }
  function render(s){
    state.textContent=s.readyToShutdown?'Klar til nedlukning af ReelShrink · Force Slet kan bruges':
      s.phase==='resuming'?'Genoptager arbejde…':
      s.phase==='stopping'?'Stopper sikkert… '+(s.activities.join(' · ')||'Gemmer køtilstand'):
      s.paused?'Samlet stop aktivt'+(s.activities.length?' · '+s.activities.join(' · '):''):
      'Normal drift'+(s.encodingPaused?' · Encodingkøen er særskilt sat på pause':'');
    stop.disabled=busy||['stopping','resuming'].includes(s.phase)||s.readyToShutdown;
    resume.disabled=busy||!s.canResume;
    if(s.error){error.hidden=false;error.textContent='Handlingen kunne ikke afsluttes: '+s.error;}
  }
  async function refresh(){
    if(busy)return;
    try{render(await api(''));}catch(e){state.textContent='Kan ikke hente stopstatus';stop.disabled=true;resume.disabled=true;error.hidden=false;error.textContent=e.message;}
  }
  async function action(route){
    busy=true;stop.disabled=true;resume.disabled=true;error.hidden=true;
    try{render(await api(route,'POST'));}catch(e){error.hidden=false;error.textContent=e.message;}
    finally{busy=false;await refresh();}
  }
  stop.onclick=()=>{if(confirm('Stop alt sikkert? Encoding afbrydes og genstarter fra begyndelsen ved Genoptag alt. Igangværende overførsler får lov at afslutte. Vent på Klar til nedlukning før du lukker containeren eller serveren.'))action('/stop');};
  resume.onclick=()=>action('/resume');
  refresh();setInterval(()=>{if(!document.hidden)refresh();},2500);
})();

