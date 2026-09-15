'use strict';
(() => {
  function login() { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)); }
  window.reelShrinkCheckAuth = response => { if (response.status === 401) login(); };
  fetch('/api/auth/session', {signal: AbortSignal.timeout(15000)})
    .then(r => r.json()).then(session => {
      if (!session.enabled) return;
      if (!session.authenticated) { login(); return; }
      const nav = document.querySelector('.section-nav'); if (!nav) return;
      const link = document.createElement('a'); link.href = '/account'; link.textContent = 'Konto';
      if (location.pathname === '/account') link.setAttribute('aria-current', 'page');
      const logout = document.createElement('button'); logout.type = 'button'; logout.className = 'button secondary'; logout.textContent = 'Log ud';
      logout.addEventListener('click', async () => {
        logout.disabled = true;
        try {
          const response = await fetch('/api/auth/logout', {method: 'POST', headers: {'Content-Type':'application/json','X-ReelShrink':'1'}, body: '{}', signal: AbortSignal.timeout(15000)});
          if (!response.ok) throw new Error();
          location.replace('/login');
        } catch { logout.textContent = 'Prøv at logge ud igen'; logout.disabled = false; }
      });
      nav.append(link, logout);
    }).catch(() => { /* Existing pages show their connection status. */ });
})();
