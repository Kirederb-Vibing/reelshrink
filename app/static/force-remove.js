'use strict';
// Shared confirmation/result UI. The dialog stays open on errors and pending requests.
window.forceRemoveDialog = function(endpoint, ids, onRemoved) {
  const existing=document.getElementById('force-remove-dialog');
  if(existing?.open)return;
  existing?.remove();
  const dialog=document.createElement('dialog');dialog.id='force-remove-dialog';
  dialog.setAttribute('aria-labelledby','force-remove-title');
  dialog.innerHTML=`<form><h2 id="force-remove-title">Force Slet valgte emner</h2><p data-summary></p><p>Dette sletter permanent lokale Work-filer, resultater, WORK_OLD og tilknyttet historik. NAS-originaler berøres ikke.</p><label>Skriv FORCE SLET<input name="confirmation" autocomplete="off" spellcheck="false" required></label><p data-status role="status" aria-live="polite"></p><div class="dialog-footer"><button type="button" data-close class="button secondary">Annullér</button><button type="submit" class="button danger">Force Slet</button></div></form>`;
  document.body.append(dialog);
  const form=dialog.querySelector('form'),input=form.elements.confirmation,submit=dialog.querySelector('[type=submit]'),close=dialog.querySelector('[data-close]'),message=dialog.querySelector('[data-status]');
  dialog.querySelector('[data-summary]').textContent=`${ids.length} emner valgt.`;
  let pending=false,finished=false;
  close.onclick=()=>{if(!pending)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  form.onsubmit=async event=>{
    event.preventDefault();if(pending||finished)return;
    if(input.value.trim().replace(/\s+/g,' ').toUpperCase()!=='FORCE SLET'){
      message.textContent='Skriv FORCE SLET i feltet for at bekræfte. Intet er slettet.';input.focus();return;
    }
    pending=true;submit.disabled=true;close.disabled=true;input.disabled=true;
    message.textContent='Sender sletningen til serveren. Vent – vinduet viser resultatet her.';
    const notice=setTimeout(()=>{message.textContent='Serveren arbejder stadig. Aktive valgte jobs skal stoppe, før lokale filer og historik kan fjernes.';},5000);
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-ReelShrink':'1'},body:JSON.stringify({ids,confirmation:'FORCE SLET'}),signal:AbortSignal.timeout(180000)});
      const raw=await response.text();let result;
      try{result=JSON.parse(raw);}catch{throw new Error(`Server/proxy returnerede HTTP ${response.status} uden et gyldigt svar. Sletningen er ikke bekræftet.`);}
      if(!response.ok)throw new Error(result.error||`Serverfejl HTTP ${response.status}`);
      if(!Number.isInteger(result.removed))throw new Error('Svaret indeholder ingen bekræftet sletning. Genindlæs siden og kontrollér serverversionen.');
      finished=true;submit.hidden=true;input.hidden=true;
      message.textContent=`Force Slet færdig: ${result.removed} valgte emner fjernet.`;
      if(result.skippedPaths?.length)message.textContent+=' Disse stier er bevaret: '+result.skippedPaths.join(', ');
      try{await onRemoved(result);}catch{message.textContent+=' Listen kunne ikke opdateres. Genindlæs siden.';}
    }catch(error){
      message.textContent=['TimeoutError','AbortError'].includes(error.name)?'Serveren svarede ikke inden 3 minutter. Oprydningen kan stadig køre. Genindlæs siden og kontrollér emnerne, før du prøver igen.':'Force Slet mislykkedes: '+error.message;
    }finally{clearTimeout(notice);pending=false;submit.disabled=false;close.disabled=false;input.disabled=false;close.textContent='Luk';}
  };
  dialog.showModal();input.focus();
};
