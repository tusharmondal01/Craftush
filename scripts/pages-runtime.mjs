export const BACKEND_MESSAGE = 'AI generation, admin and saved settings need a connected backend. You can use local editing and export tools on this site.';

export function normalizeBackendURL(value = '') {
  if (!value) return '';
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/?$/.test(url.pathname)) {
    throw new Error('PAGES_API_BASE must be the HTTPS origin of your Cloudflare backend, without a path or credentials.');
  }
  return url.origin;
}

function connectPages(config) {
  window.craftushHosting = { host: 'GitHub Pages', backendURL: config.backendURL, connected: false };
  window.craftushAPI = async function (path, options = {}) {
    if (!config.backendURL) {
      return new Response(JSON.stringify({ errors: [{ code: 'BACKEND_NOT_HOSTED', message: config.missingMessage }] }), {
        status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    // Only API routes can carry an admin password or a team code. Never forward
    // them through redirects, arbitrary URLs or other services.
    if (typeof path !== 'string' || !/^\/api\/[a-z0-9-]+(?:\?[^#]*)?$/.test(path)) {
      return new Response(JSON.stringify({ errors: [{ code: 'INVALID_API_ROUTE', message: 'Invalid Craftush API route.' }] }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    return fetch(config.backendURL + path, { ...options, credentials: 'omit', redirect: 'error' });
  };
  document.addEventListener('DOMContentLoaded', async function () {
    const notice = document.createElement('div');
    notice.id = 'hostingNotice'; notice.setAttribute('role', 'status');
    notice.style.cssText = 'padding:12px 24px;background:#183326;color:#e6f7ec;border-bottom:1px solid #476451;font:14px/1.5 system-ui,sans-serif;text-align:center';
    notice.textContent = config.backendURL ? 'v17 · Checking the Cloudflare connection…' : 'v17 · Local editing and exports are available. AI generation and admin need a connected backend.';
    document.body.prepend(notice);
    if (document.querySelector('#loginView')) {
      document.querySelectorAll('#loginView input, #loginView button').forEach(function (control) { control.disabled = !config.backendURL; });
      if (!config.backendURL) {
        const status = document.querySelector('#loginStatus');
        if (status) status.textContent = 'Admin sign-in needs the Cloudflare backend connection. Your password has not been sent.';
      }
    }
    if (!config.backendURL) return;
    try {
      const response = await window.craftushAPI('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const status = await response.json();
      if (!response.ok || status.ok !== true) throw new Error('Backend setup is incomplete');
      window.craftushHosting.connected = true;
      notice.textContent = status.runwareConfigured ? 'v17 · Cloudflare backend connected.' : 'v17 · Cloudflare backend connected. Set up Runware on the server or generate through ChatGPT.';
    } catch {
      notice.textContent = 'v17 · The Cloudflare backend is not ready. Local editing and exports are available.';
    }
  });
}

export function pagesRuntime({ backendURL = '' } = {}) {
  return '(' + connectPages.toString() + ')(' + JSON.stringify({ backendURL: normalizeBackendURL(backendURL), missingMessage: BACKEND_MESSAGE }) + ');\n';
}
