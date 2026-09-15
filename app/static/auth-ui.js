'use strict';
window.ReelShrinkAuth = {
  async api(path, data) {
    const response = await fetch('/api/auth/' + path, {
      method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json', 'X-ReelShrink': '1'},
      ...(data === undefined ? {} : {body: JSON.stringify(data)}), signal: AbortSignal.timeout(20000),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || 'Login mislykkedes.'), {status: response.status});
    return value;
  },
  supported() {
    const domain = location.hostname === 'localhost' || (location.protocol === 'https:' && !location.hostname.startsWith('[') && !/^[\d.]+$/.test(location.hostname));
    return window.isSecureContext && domain && typeof window.PublicKeyCredential !== 'undefined' && Boolean(navigator.credentials);
  },
  message(error) {
    if (error.name === 'NotAllowedError' || error.code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY') return 'Login med nøgle blev afbrudt eller fik timeout. Prøv igen, eller brug adgangskoden.';
    if (error.name === 'InvalidStateError') return 'Denne login-nøgle er allerede tilføjet.';
    if (error.name === 'SecurityError') return 'Åbn ReelShrink på dit faste HTTPS-domæne for at bruge login-nøgler.';
    if (error.name === 'TimeoutError' || error.name === 'TypeError') return 'Kunne ikke få forbindelse. Prøv igen.';
    return error.message || 'Login mislykkedes. Prøv igen.';
  },
  next() {
    try {
      const next = new URL(new URLSearchParams(location.search).get('next') || '/', location.origin);
      if (next.origin === location.origin && ['/', '/archive', '/returns', '/account'].includes(next.pathname)) return next.pathname + next.search + next.hash;
    } catch { /* Fall back to the encoding page. */ }
    return '/';
  },
};
