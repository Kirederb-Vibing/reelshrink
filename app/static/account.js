'use strict';
(() => {
  const auth = window.ReelShrinkAuth, form = document.querySelector('#key-form'), message = document.querySelector('#key-message');
  const dialog = document.querySelector('#delete-key-dialog'), deleteForm = document.querySelector('#delete-key-form');
  let selected = null;
  function failure(error) {
    if (error.status === 401) {
      // A wrong reauthentication password also returns 401; the next session check decides whether to redirect.
      auth.api('session').then(s => { if (!s.authenticated) location.replace('/login?next=%2Faccount'); }).catch(() => {});
    }
    return auth.message(error);
  }
  async function refresh() {
    const session = await auth.api('session');
    if (!session.enabled) {
      document.querySelector('#account-status').textContent = 'Login er ikke aktiveret. Indstil AUTH_USERNAME og AUTH_PASSWORD i din installation.';
      document.querySelector('#passkey-list').textContent = 'Ingen login-konto.'; form.hidden = true; return;
    }
    if (!session.authenticated) { location.replace('/login?next=%2Faccount'); return; }
    document.querySelector('#account-status').textContent = 'Logget ind som ' + session.username;
    document.querySelector('#account-username').value = session.username; document.querySelector('#delete-username').value = session.username;
    const keys = await auth.api('passkeys'), list = document.querySelector('#passkey-list'); list.replaceChildren();
    if (!keys.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Du har endnu ingen login-nøgler.'; list.append(empty); }
    for (const key of keys) {
      const row = document.createElement('article'); row.className = 'passkey-row';
      const info = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
      title.textContent = key.label; detail.className = 'hint';
      detail.textContent = key.rp_id + ' · Oprettet ' + new Date(key.created).toLocaleDateString('da-DK') + (key.last_used ? ' · Sidst brugt ' + new Date(key.last_used).toLocaleDateString('da-DK') : ' · Endnu ikke brugt');
      info.append(title, detail);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button small secondary'; remove.textContent = 'Fjern'; remove.setAttribute('aria-label', 'Fjern ' + key.label);
      remove.addEventListener('click', () => { selected = key; deleteForm.elements.password.value = ''; document.querySelector('#delete-key-name').textContent = key.label; document.querySelector('#delete-key-error').textContent = ''; dialog.showModal(); deleteForm.elements.password.focus(); });
      row.append(info, remove); list.append(row);
    }
    document.querySelector('#add-key').disabled = !auth.supported();
  }
  if (!auth.supported()) document.querySelector('#add-key-hint').textContent = 'Åbn ReelShrink med HTTPS på dit faste domænenavn og en understøttet browser for at tilføje login-nøgler.';
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = document.querySelector('#add-key'); button.disabled = true;
    message.classList.remove('auth-error'); message.textContent = 'Vælg hvor din login-nøgle skal gemmes…';
    try {
      const optionsJSON = await auth.api('passkeys/register/options', {label: form.elements.name.value, password: form.elements.password.value});
      form.elements.password.value = '';
      const response = await SimpleWebAuthnBrowser.startRegistration({optionsJSON});
      await auth.api('passkeys/register/verify', {response});
      form.reset(); await refresh();
      message.textContent = 'Login-nøglen er tilføjet. Du kan nu bruge den på login-siden.';
    } catch (error) { message.textContent = failure(error); message.classList.add('auth-error'); }
    finally { form.elements.password.value = ''; button.disabled = !auth.supported(); }
  });
  document.querySelector('#cancel-delete').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { deleteForm.elements.password.value = ''; });
  deleteForm.addEventListener('submit', async event => {
    event.preventDefault(); const buttons = deleteForm.querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
    try {
      await auth.api('passkeys/remove', {id: selected.id, rpID: selected.rp_id, password: deleteForm.elements.password.value});
      dialog.close(); await refresh();
    } catch (error) { document.querySelector('#delete-key-error').textContent = failure(error); }
    finally { deleteForm.elements.password.value = ''; buttons.forEach(b => b.disabled = false); }
  });
  refresh().catch(error => { message.textContent = failure(error); message.classList.add('auth-error'); });
})();
