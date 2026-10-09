import { normalizeBackendURL } from './pages-runtime.mjs';

const origin = normalizeBackendURL(process.env.PAGES_API_BASE || '');
if (!origin) throw new Error('Set the GitHub repository variable PAGES_API_BASE to the deployed Cloudflare backend URL before publishing this release.');
const response = await fetch(origin + '/api/health', {
  headers: { Origin: 'https://tusharmondal01.github.io' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
});
const metadata = await response.json().catch(() => ({}));
if (!response.ok || metadata.ok !== true || metadata.adminConfigured !== true || metadata.storage !== 'connected' || metadata.version !== '17') {
  throw new Error('The v17 Cloudflare backend is not ready. Check its private storage and ADMIN_PASSWORD secret before publishing.');
}
if (response.headers.get('access-control-allow-origin') !== 'https://tusharmondal01.github.io') {
  throw new Error('Cloudflare has not allowed the GitHub site origin. Check ALLOWED_ORIGINS before publishing.');
}
if (metadata.rateLimiting?.enabled !== true) {
  throw new Error('The rate-limited v17 backend is not deployed yet. Wait for the Cloudflare Git build before publishing the frontend.');
}
console.log('Cloudflare backend ready: v17, private storage, admin, rate limiting and GitHub CORS verified.');
