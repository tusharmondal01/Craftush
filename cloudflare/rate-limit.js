const encoder = new TextEncoder();
const integer = (value, fallback) => /^[1-9]\d*$/.test(String(value || '')) && Number(value) <= 1000000 ? Number(value) : fallback;

export function publicRateLimits(environment) {
  return {
    enabled: true,
    generationPerMinute: integer(environment.RATE_LIMIT_AI_MINUTE, 120),
    generationPerHour: integer(environment.RATE_LIMIT_AI_HOUR, 1200),
    lookupPerMinute: integer(environment.RATE_LIMIT_LOOKUP_MINUTE, 300),
    adminAttemptsPer10Minutes: integer(environment.RATE_LIMIT_ADMIN_ATTEMPTS, 10),
  };
}

export function initializeRateLimits(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS rate_limits (name TEXT PRIMARY KEY, used INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
}

// All windows are checked and charged together. Rejected requests never consume
// another window's remaining quota. SQLite retains counters across deployments.
export function consumeQuota(storage, rules, now = Date.now()) {
  if (!Array.isArray(rules) || !rules.length || rules.length > 4 || rules.some(rule =>
    !rule || !/^[a-z-]{1,40}$/.test(rule.name) ||
    !Number.isSafeInteger(rule.limit) || rule.limit < 1 || rule.limit > 1000000 ||
    !Number.isSafeInteger(rule.weight) || rule.weight < 1 || rule.weight > 1000000 ||
    !Number.isSafeInteger(rule.periodMs) || rule.periodMs < 1000 || rule.periodMs > 86400000) ||
    new Set(rules.map(rule => rule.name)).size !== rules.length) throw new Error('Invalid rate-limit rules');
  return storage.transactionSync(() => {
    const windows = rules.map(rule => {
      const row = storage.sql.exec('SELECT used, reset_at FROM rate_limits WHERE name = ?', rule.name).toArray()[0];
      return { ...rule, used: row && row.reset_at > now ? row.used : 0,
        resetAt: row && row.reset_at > now ? row.reset_at : now + rule.periodMs };
    });
    if (windows.some(window => window.weight > window.limit)) return { allowed: false, oversized: true, retryAfter: 0 };
    const blocked = windows.filter(window => window.used + window.weight > window.limit);
    if (blocked.length) return { allowed: false, retryAfter: Math.max(1, ...blocked.map(window => Math.ceil((window.resetAt - now) / 1000))) };
    for (const window of windows) {
      storage.sql.exec('INSERT INTO rate_limits (name, used, reset_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET used = excluded.used, reset_at = excluded.reset_at',
        window.name, window.used + window.weight, window.resetAt);
    }
    return { allowed: true, retryAfter: 0 };
  });
}

const reply = (code, message, status, extra = {}) => Response.json({ errors: [{ code, message }], ...extra },
  { status, headers: { 'cache-control': 'no-store' } });

export function requestRateLimiter(request, environment) {
  const limits = publicRateLimits(environment);
  let objectPromise;
  const object = () => objectPromise ||= (async () => {
    const secret = environment.ADMIN_PASSWORD || environment.RUNWARE_API_KEY;
    if (!secret || !environment.CRAFTUSH_DATA?.idFromName || !environment.CRAFTUSH_DATA?.get) throw new Error('Rate limiter is not bound');
    // Only Cloudflare's trusted client address identifies a visitor. Forwarded
    // headers, user-supplied IDs and password guesses cannot change the bucket.
    // No plaintext address or credential is stored in a counter or object name.
    const address = request.headers.get('cf-connecting-ip') || 'unknown-client';
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode('craftush-rate-v1:' + address));
    const identity = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return environment.CRAFTUSH_DATA.get(environment.CRAFTUSH_DATA.idFromName('rate-v17-' + identity));
  })();

  async function consume(rules, scope) {
    try {
      const stub = await object();
      const response = await stub.fetch(new Request('https://private-storage.invalid/rate-limit', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules }),
      }));
      if (!response.ok) throw new Error('Quota storage is unavailable');
      const result = await response.json();
      if (result.allowed === true) return null;
      if (result.allowed !== false) throw new Error('Invalid quota response');
      if (result.oversized) return reply('RATE_LIMIT_BATCH_TOO_LARGE', 'This batch requests too many results. Reduce the number of images or tasks per batch.', 400);
      if (!Number.isSafeInteger(result.retryAfter) || result.retryAfter < 1) throw new Error('Invalid retry time');
      const blocked = reply('RATE_LIMITED', 'Too many ' + scope + '. Please wait ' + result.retryAfter + ' seconds and try again.', 429,
        { retryAfter: result.retryAfter });
      blocked.headers.set('Retry-After', String(result.retryAfter));
      return blocked;
    } catch {
      // A failed counter must never silently permit a paid provider call.
      return reply('RATE_LIMIT_UNAVAILABLE', 'Request limits could not be checked. Please try again shortly.', 503);
    }
  }

  return {
    admin: () => consume([{ name: 'admin-login', limit: limits.adminAttemptsPer10Minutes, weight: 1, periodMs: 600000 }], 'sign-in attempts'),
    async runware(tasks) {
      let generation = 0, lookup = 0;
      for (const task of tasks) {
        if (task.taskType === 'authentication') continue;
        if (task.taskType === 'getResponse' || task.taskType === 'modelSearch') { lookup++; continue; }
        const count = Number(task.numberResults ?? 1);
        generation += Number.isFinite(count) ? Math.max(1, Math.min(1000000, Math.ceil(count))) : 1000000;
      }
      const rules = [];
      if (generation) rules.push(
        { name: 'generation-minute', limit: limits.generationPerMinute, weight: Math.min(generation, 1000000), periodMs: 60000 },
        { name: 'generation-hour', limit: limits.generationPerHour, weight: Math.min(generation, 1000000), periodMs: 3600000 });
      if (lookup) rules.push({ name: 'lookup-minute', limit: limits.lookupPerMinute, weight: lookup, periodMs: 60000 });
      return rules.length ? consume(rules, generation ? 'generation requests' : 'result or model lookups') : null;
    },
  };
}
