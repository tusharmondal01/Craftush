import admin from '../netlify/edge-functions/admin.js';
import runware from '../netlify/edge-functions/runware.js';
import tools from '../netlify/edge-functions/tools.js';
import thumbnail from '../netlify/edge-functions/thumbnail.js';
import documentary from '../netlify/edge-functions/documentary.js';
import media from '../netlify/edge-functions/documentary-media.js';
import bridge from '../netlify/edge-functions/chatgpt-bridge.js';
import { createChatGPTMCP } from '../netlify/lib/chatgpt-mcp.js';
import { activeKey, env, json, openStore, readSettings } from '../netlify/lib/shared.js';
import { withRuntime } from '../netlify/lib/runtime-context.js';
import { cloudflareStore } from './storage.js';
export { CraftushStorage } from './storage.js';

const mcp = createChatGPTMCP(bridge, {
  projectPage: () => (env('PUBLIC_SITE_URL') || 'https://tusharmondal01.github.io/Craftush').replace(/\/+$/, '') + '/chatgpt/',
});
const routes = new Map([
  ['/api/admin', admin], ['/api/runware', runware], ['/api/tools', tools],
  ['/api/thumbnail', thumbnail], ['/thumbnail', thumbnail],
  ['/api/documentary', documentary], ['/api/documentary-media', media],
  ['/api/chatgpt-bridge', bridge], ['/api/chatgpt-mcp', mcp],
]);
const error = (code, message, status) => json({ errors: [{ code, message }] }, status);

function allowedOrigin(request, environment) {
  const origin = request.headers.get('origin');
  if (!origin) return '';
  const allowed = new Set([new URL(request.url).origin]);
  for (const value of String(environment.ALLOWED_ORIGINS || 'https://tusharmondal01.github.io').split(',')) {
    try { allowed.add(new URL(value.trim()).origin); } catch { /* invalid entries never permit an origin */ }
  }
  if (new URL(request.url).pathname === '/api/chatgpt-mcp') allowed.add('https://chatgpt.com');
  return allowed.has(origin) ? origin : null;
}

function headersFor(response, origin) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.append('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password, X-Team-Code, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID');
    headers.set('Access-Control-Expose-Headers', 'X-Media-Total, X-Media-Next, MCP-Session-Id');
    headers.set('Access-Control-Max-Age', '600');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, environment) {
    const origin = allowedOrigin(request, environment);
    if (origin === null) return error('ORIGIN_NOT_ALLOWED', 'This website is not allowed to use the Craftush backend.', 403);
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    if (path === '' && request.method === 'GET') {
      const site = environment.PUBLIC_SITE_URL || 'https://tusharmondal01.github.io/Craftush';
      return headersFor(Response.redirect(site.replace(/\/+$/, '') + '/', 302), origin);
    }
    const handler = routes.get(path);
    if (!handler && path !== '/api/health') return headersFor(error('NOT_FOUND', 'Unknown Craftush API route.', 404), origin);
    if (request.method === 'OPTIONS') return headersFor(new Response(null, { status: 204 }), origin);
    try {
      const store = cloudflareStore(environment.CRAFTUSH_DATA);
      return await withRuntime(environment, store, async () => {
        let response;
        if (path === '/api/health') {
          if (request.method !== 'GET') response = error('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
          else {
            const settings = await readSettings(openStore());
            const adminConfigured = !!env('ADMIN_PASSWORD');
            response = json({ ok: adminConfigured, version: '17', storage: 'connected', adminConfigured,
              runwareConfigured: !!activeKey(settings) }, adminConfigured ? 200 : 503);
          }
        } else response = await handler(request);
        return headersFor(response, origin);
      });
    } catch {
      // Do not expose exception text, provider credentials or private values.
      return headersFor(error('BACKEND_STORAGE_UNAVAILABLE', 'Cloudflare private storage is unavailable. Check the CRAFTUSH_DATA binding and retry.', 503), origin);
    }
  },
};
