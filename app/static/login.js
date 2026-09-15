'use strict';
(() => {
  const auth = window.ReelShrinkAuth, form = document.querySelector('#login-form');
  const passkey = document.querySelector('#passkey-login'), message = document.querySelector('#login-message');
  const supported = auth.supported();
  passkey.disabled = !supported;
  if (!supported) document.querySelector('#passkey-hint').textContent = 'Login-nøgler kræver HTTPS og en understøttet browser. Du kan stadig logge ind med adgangskoden.';
  function busy(value, text = '') {
    form.querySelector('button').disabled = value; passkey.disabled = value || !supported;
    message.textContent = text; message.classList.remove('auth-error');
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); busy(true, 'Logger ind…');
    try {
      await auth.api('login', {username: form.elements.username.value, password: form.elements.password.value, remember: form.elements.remember.checked});
      location.replace(auth.next());
    } catch (error) { busy(false, auth.message(error)); message.classList.add('auth-error'); }
  });
  passkey.addEventListener('click', async () => {
    busy(true, 'Vælg din login-nøgle i fx Bitwarden…');
    try {
      const optionsJSON = await auth.api('passkeys/authenticate/options', {remember: form.elements.remember.checked});
      const response = await SimpleWebAuthnBrowser.startAuthentication({optionsJSON});
      await auth.api('passkeys/authenticate/verify', {response});
      location.replace(auth.next());
    } catch (error) { busy(false, auth.message(error)); message.classList.add('auth-error'); }
  });
})();
