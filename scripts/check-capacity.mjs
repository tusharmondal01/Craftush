// A bounded, read-only check of the public deployment. Never calls Runware.
import { writeFile, appendFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const targets = [
  'https://tusharmondal01.github.io/Craftush/',
  'https://tusharmondal01.github.io/Craftush/visuals/',
  'https://tusharmondal01.github.io/Craftush/comfy/',
  'https://tusharmondal01.github.io/Craftush/documentary/',
  'https://craftush.tushar-mondal.workers.dev/api/health',
];
const limit = 5000, concurrent = 4, observations = [], active = new Set();
let stopped = '', errors = 0, nextStart = performance.now();
const started = performance.now();
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1]) : null;
};
async function request(index) {
  const url = targets[index % targets.length], begin = performance.now();
  let status = 0, bytes = 0, error = '';
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': 'Craftush-authorized-capacity-check/1.0', origin: 'https://tusharmondal01.github.io' } });
    status = response.status;
    const text = await response.text(); bytes = Buffer.byteLength(text);
    if (status !== 200) throw new Error('HTTP ' + status);
    if (url.endsWith('/api/health')) {
      const health = JSON.parse(text);
      if (health.ok !== true || health.storage !== 'connected' || health.rateLimiting?.enabled !== true) throw new Error('Backend health check failed');
    } else if (!/<!doctype html>/i.test(text.slice(0, 150))) throw new Error('Unexpected page response');
  } catch (e) {
    error = e.message; errors++;
    if (status !== 200 || errors >= 3) stopped ||= `${url}: ${error}`;
  }
  observations.push({ index: index + 1, url, status, bytes, ms: Math.round(performance.now() - begin), error });
  if (observations.length % 500 === 0) console.log(JSON.stringify({ completed: observations.length, errors, p95Ms: percentile(observations.slice(-500).map(r => r.ms), .95) }));
  if (observations.length % 100 === 0 && percentile(observations.slice(-100).map(r => r.ms), .95) > 5000) stopped ||= 'Responses slowed beyond the 5-second p95 stop threshold.';
}

for (let i = 0; i < limit && !stopped; i++) {
  while (active.size >= concurrent) await Promise.race(active);
  if (stopped) break;
  await wait(Math.max(0, nextStart - performance.now()));
  if (stopped) break;
  // Ramp gradually: 2/s for the first 50, 5/s for 150, then at most 10/s.
  const rate = i < 50 ? 2 : i < 200 ? 5 : 10;
  nextStart = performance.now() + 1000 / rate;
  const pending = request(i).finally(() => active.delete(pending)); active.add(pending);
}
await Promise.all(active);
observations.sort((a, b) => a.index - b.index);
const elapsedSeconds = (performance.now() - started) / 1000;
const byTarget = targets.map(url => {
  const rows = observations.filter(r => r.url === url), times = rows.map(r => r.ms);
  return { url, requests: rows.length, successful: rows.filter(r => !r.error).length,
    statuses: rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
    meanMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    p95Ms: percentile(times, .95), p99Ms: percentile(times, .99), maxMs: times.length ? Math.max(...times) : null };
});
const report = { date: new Date().toISOString(), requested: limit, completed: observations.length, successful: observations.filter(r => !r.error).length,
  errors, stopReason: stopped || null, elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
  requestsPerSecond: Math.round(observations.length / elapsedSeconds * 100) / 100, maxConcurrency: concurrent, maxRatePerSecond: 10,
  runwareGenerationCalls: 0, byTarget, failures: observations.filter(r => r.error),
  scope: 'HTTP GET page documents and backend health only. Does not simulate 5,000 simultaneous people, media downloads, or paid AI generation.' };
await writeFile('capacity-report.json', JSON.stringify(report, null, 2));
console.log('CAPACITY_REPORT ' + JSON.stringify(report));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `### Controlled Craftush capacity check\n\n${report.successful} / ${limit} requests succeeded in ${report.elapsedSeconds}s. Peak configured rate: 10/s; maximum in flight: 4.\n\n` +
  '| Route | Requests | Success | Mean ms | p95 ms | p99 ms |\n|---|---:|---:|---:|---:|---:|\n' +
  byTarget.map(t => `| ${t.url} | ${t.requests} | ${t.successful} | ${t.meanMs} | ${t.p95Ms} | ${t.p99Ms} |`).join('\n') +
  `\n\n${report.scope}\n${stopped ? 'Stopped early: ' + stopped : ''}\n`);
if (observations.length !== limit || errors) process.exitCode = 1;
