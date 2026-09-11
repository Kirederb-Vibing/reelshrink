'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = n => { if (!n) return '0 B'; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + ['B','KiB','MiB','GiB','TiB'][i]; };
const names = { waiting:'Venter på stabil fil', ready:'Klar til flytning', ambiguous:'Vælg original', unmatched:'Intet sikkert match', blocked:'Blokeret', failed:'Fejlet', missing:'Flyttet / ændret', queued:'I flyttekø', working:'Kontrollerer / flytter', attention:'Kræver gendannelse', done:'Flyttet · OLD gemt', deleted:'OLD slettet', restored:'Original gendannet', deleting:'Sletter OLD' };
const reviewStates = ['ambiguous','unmatched','blocked','attention','failed'];
let data = null, selected = new Set(), unsafeSelected = new Set(), oldSelected = new Set(), offset = 0, visible = [], refreshing = false, initialized = false, pendingConfirm = null, busy = false;
async function api(url, method = 'GET', body) {
  const r = await fetch('/api/returns' + url, { method, headers: { 'Content-Type':'application/json', 'X-ReelShrink':'1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error || 'Forespørgslen fejlede.'); return value;
}
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6000); }
function syncSelection() {
  $('selected-count').textContent = `${selected.size} valgt (maks. 100)`;
  $('old-selected-count').textContent = `${oldSelected.size} valgt`;
  $('move-selected').disabled = busy || !selected.size || data?.scanning;
  $('delete-selected').disabled = busy || !oldSelected.size || data?.scanning || Boolean(data?.active);
  const eligible = visible.filter(r => r.state === 'ready' || r.canUnsafe);
  $('select-page').checked = eligible.length > 0 && eligible.every(r => selected.has(r.id));
  $('select-page').indeterminate = eligible.some(r => selected.has(r.id)) && !$('select-page').checked;
  $('select-page').disabled = !eligible.length;
  const old = data?.items.filter(r => r.state === 'done') || [];
  $('select-old').checked = old.length > 0 && old.every(r => oldSelected.has(r.id));
  $('select-old').indeterminate = old.some(r => oldSelected.has(r.id)) && !$('select-old').checked;
  $('select-old').disabled = !old.length;
  for (const input of document.querySelectorAll('[data-select]')) input.checked = (input.dataset.select === 'old' ? oldSelected : selected).has(input.value);
  for (const input of document.querySelectorAll('[data-unsafe-return]')) input.checked = unsafeSelected.has(input.value);
}
function render() {
  if (!data) return;
  const items = data.items, q = $('search').value.toLowerCase(), filter = $('filter').value;
  for (const id of selected) if (!items.some(r => r.id === id && (r.state === 'ready' || r.canUnsafe))) { selected.delete(id); unsafeSelected.delete(id); }
  for (const id of oldSelected) if (!items.some(r => r.id === id && r.state === 'done')) oldSelected.delete(id);
  $('connection').textContent = data.active ? 'Arbejder…' : data.scanning ? 'Scanner…' : 'Forbundet'; $('connection').className = 'connection ok';
  $('ready').textContent = items.filter(r => r.state === 'ready').length;
  $('review').textContent = items.filter(r => reviewStates.includes(r.state)).length;
  const old = items.filter(r => r.state === 'done');
  $('old-count').textContent = old.length; $('old-size').textContent = bytes(old.reduce((sum, r) => sum + (r.details.originalBytes || 0), 0));
  $('scan-time').textContent = data.lastScan ? 'Senest scannet ' + new Date(data.lastScan).toLocaleTimeString('da-DK') : 'Afventer scanning';
  $('error').hidden = !data.scanError; $('error').textContent = data.scanError || '';
  const filtered = items.filter(r => (filter === 'all' || filter === 'ready' && r.state === 'ready' || filter === 'review' && reviewStates.includes(r.state) || filter === 'pending' && !['done','deleted','restored','missing'].includes(r.state)) && (r.input + ' ' + r.original).toLowerCase().includes(q));
  const size = $('page-size').value === 'all' ? Math.max(1, filtered.length) : Number($('page-size').value);
  if (offset >= filtered.length) offset = Math.max(0, Math.ceil(filtered.length / size) * size - size);
  visible = filtered.slice(offset, offset + size);
  // Preserve a focused select while polling, so choosing an ambiguous match is stable.
  if (!$('matches').contains(document.activeElement)) $('matches').innerHTML = visible.map(r => `<article class="return-row"><div class="return-file"><input class="job-checkbox" type="checkbox" data-select="move" value="${esc(r.id)}" aria-label="Vælg ${esc(r.input)}" ${r.state === 'ready' || r.canUnsafe ? '' : 'disabled'}><div><strong>${esc(r.input.split('/').pop())}</strong><span class="badge ${r.state === 'ready' || r.state === 'done' ? 'completed' : r.state === 'attention' || r.state === 'failed' ? 'failed' : 'queued'}">${esc(names[r.state] || r.state)}</span><p class="hint">${esc(r.error)}</p><div class="return-paths"><span>Fra</span><code>${esc(r.input)}</code><span>Til</span><code>${esc(r.details.target || r.original || 'Afventer match')}</code></div><p class="hint">${r.mode === 'reelshrink' ? 'Reelshrink-job' : 'Navnesammenligning'} · ${bytes(r.details.inputBytes)}${r.details.originalBytes ? ' · original ' + bytes(r.details.originalBytes) : ''}</p>${r.canUnsafe ? `<label class="check unsafe-choice"><input type="checkbox" data-unsafe-return value="${esc(r.id)}"><span>Usikker flytning · slet original uden medietest eller OLD</span></label>` : ''}${r.state === 'attention' && r.details.backup ? `<p class="hint">Original/backup: <code>${esc(r.details.backup)}</code><br>Midlertidig kopi: <code>${esc(r.details.temp)}</code></p>` : ''}</div></div><div class="actions return-row-actions">${r.state === 'ready' ? `<button class="button small primary" data-action="move" data-id="${esc(r.id)}">Flyt</button>` : ''}${r.state === 'ambiguous' ? `<label>Original<select data-choice="${esc(r.id)}"><option value="">Vælg rigtig original…</option>${r.details.candidates.map(file => `<option value="${esc(file)}">${esc(file)}</option>`).join('')}</select></label>` : ''}${r.state === 'failed' ? `<button class="button small secondary" data-action="retry" data-id="${esc(r.id)}">Prøv igen</button>` : ''}${r.state === 'attention' ? `<button class="button small secondary" data-action="restore" data-id="${esc(r.id)}">Gendan original</button>` : ''}</div></article>`).join('') || '<div class="empty"><h2>Ingen filer i denne visning</h2><p>Færdige resultater vises efter stabilitetskontrollen. Brug Scan nu, eller tilføj en fra- og tilmappe.</p></div>';
  $('old-list').innerHTML = old.map(r => `<article class="return-row"><div class="return-file"><input type="checkbox" class="job-checkbox" data-select="old" value="${esc(r.id)}" aria-label="Vælg ${esc(r.details.backup)}"><div><strong>${esc(r.details.backup.split('/').pop())}</strong><p class="hint">${bytes(r.details.originalBytes)} · flyttet ${new Date(r.updated).toLocaleString('da-DK')}</p><div class="return-paths"><span>OLD</span><code>${esc(r.details.backup)}</code><span>Ny fil</span><code>${esc(r.details.target)}</code></div></div></div><div class="actions return-row-actions"><button class="button small secondary" data-action="restore" data-id="${esc(r.id)}">Gendan original</button><button class="button small danger" data-action="delete" data-id="${esc(r.id)}">Slet OLD</button></div></article>`).join('') || '<div class="empty"><h2>Ingen originaler venter på sletning</h2><p>Efter en tilbageflytning vises den bevarede original her.</p></div>';
  $('pagination').hidden = filtered.length <= size; $('previous').disabled = !offset; $('next').disabled = offset + size >= filtered.length;
  $('page-info').textContent = `${filtered.length ? offset + 1 : 0}–${Math.min(offset + size, filtered.length)} af ${filtered.length}`;
  $('scan').disabled = busy || data.scanning || Boolean(data.active); syncSelection();
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    data = await api('');
    $('archive-note').textContent = data.workRoot ? 'Arbejdsarkiv er aktivt. Denne fane flytter kun lokalt. Godkend resultatet i OLD-køen, og vælg derefter Send til server i Arbejdsarkiv-fanen.' : '';
    if (!initialized) {
      $('automatic').checked = data.options.automatic; $('from').value = data.options.from; $('to').value = data.options.to;
      $('input-roots').innerHTML = data.inputRoots.map(p => `<option value="${esc(p)}"></option>`).join('');
      $('media-roots').innerHTML = data.mediaRoots.map(p => `<option value="${esc(p)}"></option>`).join('');
      $('roots-note').textContent = `Tilladte fra-mapper: ${data.inputRoots.join(', ')}. Til-mapper: ${data.mediaRoots.join(', ')}. Stabilitet: ${data.stableSeconds} sekunder.`;
      initialized = true;
    }
    render();
  } catch (e) { $('error').textContent = e.message; $('error').hidden = false; $('connection').textContent = 'Ingen forbindelse'; }
  finally { refreshing = false; }
}
function confirm(action, ids) {
  const rows = ids.map(id => data.items.find(r => r.id === id)).filter(Boolean);
  if (!rows.length) return;
  pendingConfirm = { action, ids };
  const deleting = action === 'delete', restoring = action === 'restore';
  $('confirm-title').textContent = deleting ? `Slet ${rows.length} OLD-fil(er) permanent?` : restoring ? 'Gendan originalen?' : `Flyt ${rows.length} fil(er) tilbage?`;
  const unsafe = action === 'move' && ids.some(id => unsafeSelected.has(id));
  $('confirm-description').textContent = deleting ? 'Kun de viste OLD-filer slettes. Det kan ikke fortrydes.' : restoring ? 'Originalen sættes tilbage. Den nye video og øvrige kopier bevares til manuel gennemgang.' : unsafe ? 'Usikkert valgte filer kopieres med checksum, men uden medietest. Den registrerede original slettes straks uden OLD-kø.' : 'Videoen kontrolleres, kopieres og sættes ind i den oprindelige mappe. Originalen gemmes med .OLD. Fra-videoen fjernes efter kontrollen.';
  $('confirm-paths').textContent = rows.map(r => deleting ? r.details.backup : restoring ? r.original : unsafeSelected.has(r.id) ? `[USIKKER]\n${r.input}\n→ ${r.original.replace(/\.[^.\/]+$/, '') + r.input.slice(r.input.lastIndexOf('.'))}\nOriginal slettes uden OLD` : `${r.input}\n→ ${r.original.replace(/\.[^.\/]+$/, '') + r.input.slice(r.input.lastIndexOf('.'))}\nOriginal → ${r.original}.OLD`).join('\n\n');
  $('delete-confirmation').hidden = !deleting; $('confirmation-text').value = ''; $('confirm-submit').textContent = deleting ? 'Slet OLD permanent' : restoring ? 'Gendan original' : 'Kontrollér og flyt';
  $('confirm-submit').disabled = deleting; $('confirm-submit').className = 'button ' + (deleting || unsafe ? 'danger' : 'primary');
  $('confirm-dialog').showModal();
}
async function action(url, method, body) {
  busy = true; syncSelection();
  try { await api(url, method, body); await refresh(); return true; }
  catch (e) { toast(e.message); await refresh(); return false; }
  finally { busy = false; syncSelection(); }
}
$('settings-form').onsubmit = async e => {
  e.preventDefault(); $('save-settings').disabled = true;
  const ok = await action('/settings','PUT',{ automatic:$('automatic').checked, from:$('from').value.trim(), to:$('to').value.trim() });
  if (ok) { $('saved-settings').textContent = 'Indstillinger gemt'; await action('/scan','POST',{}); }
  $('save-settings').disabled = false;
};
$('scan').onclick = () => action('/scan','POST',{});
for (const id of ['filter','page-size','search']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { offset = 0; selected.clear(); render(); });
$('previous').onclick = () => { offset = Math.max(0,offset - Number($('page-size').value)); render(); };
$('next').onclick = () => { offset += Number($('page-size').value); render(); };
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.select) { const set = el.dataset.select === 'old' ? oldSelected : selected; if (el.checked && set.size >= 100) { el.checked = false; toast('Vælg højst 100 filer.'); } else if (el.checked) { set.add(el.value); const row=data.items.find(r=>r.id===el.value);if(el.dataset.select==='move'&&row?.state!=='ready'&&row?.canUnsafe)unsafeSelected.add(el.value); } else { set.delete(el.value);unsafeSelected.delete(el.value); } syncSelection(); }
  if (el.dataset.unsafeReturn !== undefined) { if(el.checked){unsafeSelected.add(el.value);selected.add(el.value);}else{unsafeSelected.delete(el.value);const row=data.items.find(r=>r.id===el.value);if(row?.state!=='ready')selected.delete(el.value);}syncSelection(); }
  if (el.dataset.choice && el.value) { el.blur(); await action('/' + el.dataset.choice + '/choose','POST',{original:el.value}); }
});
$('select-page').onchange = () => { const rows = visible.filter(r => r.state === 'ready' || r.canUnsafe); if ($('select-page').checked && new Set([...selected,...rows.map(r=>r.id)]).size > 100) toast('Vælg højst 100 filer.'); else for (const r of rows) if ($('select-page').checked) {selected.add(r.id);if(r.state!=='ready')unsafeSelected.add(r.id);} else {selected.delete(r.id);unsafeSelected.delete(r.id);} syncSelection(); };
$('select-old').onchange = () => { const rows = data.items.filter(r => r.state === 'done'); if ($('select-old').checked) for (const r of rows.slice(0,100)) oldSelected.add(r.id); else oldSelected.clear(); syncSelection(); };
document.addEventListener('click', e => { const button = e.target.closest('[data-action]'); if (!button || busy) return; const {action:kind,id} = button.dataset; if (kind === 'retry') action('/'+id+'/retry','POST',{}); else confirm(kind,[id]); });
$('move-selected').onclick = () => confirm('move',[...selected]);
$('delete-selected').onclick = () => confirm('delete',[...oldSelected]);
$('close-confirm').onclick = $('cancel-confirm').onclick = () => $('confirm-dialog').close();
$('confirmation-text').oninput = () => $('confirm-submit').disabled = $('confirmation-text').value !== 'SLET OLD';
$('confirm-form').onsubmit = async e => {
  e.preventDefault(); const p = pendingConfirm; if (!p || busy) return;
  if (p.action === 'delete' && $('confirmation-text').value !== 'SLET OLD') return;
  $('confirm-dialog').close();
  const url = p.action === 'restore' ? '/' + p.ids[0] + '/restore' : p.action === 'delete' ? '/delete-old' : '/move';
  const ok = await action(url,'POST',{ids:p.ids,unsafeIds:p.action === 'move' ? p.ids.filter(id=>unsafeSelected.has(id)) : undefined,confirmation:p.action === 'delete' ? 'SLET OLD' : undefined});
  if (ok) { toast(p.action === 'move' ? 'Filerne er sat i flyttekø.' : p.action === 'delete' ? 'De valgte OLD-filer er slettet.' : 'Originalen er gendannet.'); selected.clear(); unsafeSelected.clear(); oldSelected.clear(); syncSelection(); }
};
refresh(); setInterval(() => { if (!document.hidden && !$('confirm-dialog').open) refresh(); }, 3000);
