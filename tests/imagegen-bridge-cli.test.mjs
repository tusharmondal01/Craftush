import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/imagegen-bridge.mjs', import.meta.url));
const token = 'ir_' + 'c'.repeat(64);
const config = { version: 1, backendURL: 'https://backend.craftush.test', apiPath: '/api/image-requests', runnerId: randomUUID(), runnerToken: token };

function command(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (result.error) throw result.error;
  return result;
}
function sddl(path) {
  const result = command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Acl -LiteralPath $env:CRAFTUSH_ACL_PATH | Select-Object -ExpandProperty Sddl'], { ...process.env, CRAFTUSH_ACL_PATH: path });
  assert.equal(result.status, 0, 'Windows can inspect the test ACL');
  return result.stdout.trim();
}
function identities() {
  const current = command('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  assert.equal(current.status, 0);
  const currentSID = current.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  const ownerSID = sddl(workspace).match(/^O:(S-1-\d+(?:-\d+)+)/)?.[1];
  assert.ok(currentSID); assert.ok(ownerSID);
  return [...new Set([currentSID, ownerSID, 'S-1-5-18'])].sort();
}
function assertPrivate(value, expected) {
  const dacl = value.split('D:')[1]?.split('S:')[0] || '';
  assert.ok(dacl.startsWith('P'), 'inheritance is protected');
  const aces = [...dacl.matchAll(/\(([^()]+)\)/g)].map(match => match[1].split(';'));
  const trustees = aces.map(ace => ace[5] === 'SY' ? 'S-1-5-18' : ace[5]);
  assert.deepEqual(trustees.sort(), expected, 'only current user, workspace owner and SYSTEM have access');
  assert.ok(aces.every(ace => ace[0] === 'A' && !ace[1].includes('ID')), 'only explicit allow entries remain');
  assert.ok(aces.every(ace => ['FA', '0x1f01ff'].includes(ace[2])), 'approved principals have full control');
}
async function absent(path) {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

// A child-process preloader observes the real Windows permissions at the exact
// token write boundary and replaces all fetch calls with a local fake response.
const instrument = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
const originalWrite = fs.writeFile;
const originalRead = fs.readFile;
function acl(path) {
  const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command','Get-Acl -LiteralPath $env:CRAFTUSH_ACL_PATH | Select-Object -ExpandProperty Sddl'],{env:{...process.env,CRAFTUSH_ACL_PATH:path},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0); return result.stdout.trim();
}
function verify(value) {
  const dacl=value.split('D:')[1]?.split('S:')[0]||'';
  assert.ok(dacl.startsWith('P'));
  const aces=[...dacl.matchAll(/\\(([^()]+)\\)/g)].map(match=>match[1].split(';'));
  assert.ok(aces.every(ace=>ace[0]==='A'&&!ace[1].includes('ID')));
  assert.deepEqual(aces.map(ace=>ace[5]==='SY'?'S-1-5-18':ace[5]).sort(),JSON.parse(process.env.CRAFTUSH_TEST_IDENTITIES));
}
fs.writeFile=async function(path,data,...args) {
  if(String(data).includes(process.env.CRAFTUSH_TEST_RUNNER_TOKEN)) {
    const before=await originalRead(path);
    assert.equal(before.length,0,'credential file is empty until its permissions are secured');
    const fileACL=acl(path), directoryACL=acl(dirname(path));
    verify(fileACL); verify(directoryACL);
    await originalWrite(process.env.CRAFTUSH_TEST_WRITE_AUDIT,JSON.stringify({beforeBytes:before.length,fileACL,directoryACL}));
  }
  return originalWrite(path,data,...args);
};
syncBuiltinESMExports();
globalThis.fetch=async function(url,options) {
  const parsed=new URL(url);
  assert.equal(parsed.origin,'https://backend.craftush.test');
  assert.equal(parsed.pathname,'/api/image-requests');
  assert.equal(options.headers['X-Image-Runner'],process.env.CRAFTUSH_TEST_RUNNER_TOKEN);
  assert.equal(options.redirect,'error');
  await originalWrite(process.env.CRAFTUSH_TEST_NETWORK_AUDIT,JSON.stringify({action:parsed.searchParams.get('action'),scopedToken:true}));
  return new Response(JSON.stringify({generator:{paired:true,connected:false,state:'offline'}}),{headers:{'Content-Type':'application/json'}});
};
`;

test('Windows CLI secures empty credential files before token writes and refuses unsafe access before fetch', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'craftush-imagegen-cli-'));
  t.after(async () => {
    const absolute = resolve(directory), base = resolve(tmpdir());
    assert.ok(absolute.startsWith(base + sep) && basename(absolute).startsWith('craftush-imagegen-cli-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const expected = identities();
  const source = join(directory, 'downloaded-connection.json');
  const preload = join(directory, 'observe-cli.mjs');
  const writeAudit = join(directory, 'before-token-write.json');
  const networkAudit = join(directory, 'fake-network-call.json');
  const stateDirectory = join(directory, 'state');
  const credentialDirectory = join(stateDirectory, 'credentials', config.runnerId);
  const secret = join(credentialDirectory, 'connection.private.json');
  const pointer = join(stateDirectory, 'connection.json');
  await writeFile(source, JSON.stringify(config));
  await writeFile(preload, instrument);
  const env = { ...process.env, CRAFTUSH_TEST_IDENTITIES: JSON.stringify(expected), CRAFTUSH_TEST_RUNNER_TOKEN: token, CRAFTUSH_TEST_WRITE_AUDIT: writeAudit, CRAFTUSH_TEST_NETWORK_AUDIT: networkAudit };
  function run(action, ...args) { return command(process.execPath, ['--import', pathToFileURL(preload).href, cli, action, '--state-dir', stateDirectory, ...args], env); }
  function noToken(result) {
    assert.equal((result.stdout + result.stderr).includes(token), false, 'the runner token is never printed');
    assert.doesNotMatch(result.stdout + result.stderr, /ir_[a-f0-9]{64}/i);
  }

  await t.test('configure protects the directory and empty temporary file before writing, then emits only safe metadata', async () => {
    const result = run('configure', '--file', source);
    noToken(result); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output, { state: 'configured', backendURL: config.backendURL, runnerId: config.runnerId });
    const audit = JSON.parse(await readFile(writeAudit, 'utf8'));
    assert.equal(audit.beforeBytes, 0);
    assertPrivate(audit.fileACL, expected); assertPrivate(audit.directoryACL, expected);
    assertPrivate(sddl(secret), expected); assertPrivate(sddl(credentialDirectory), expected);
    assert.deepEqual(JSON.parse(await readFile(secret, 'utf8')), config);
    assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), { version: 1, runnerId: config.runnerId });
    assert.equal((await readFile(pointer, 'utf8')).includes(token), false, 'the public identity pointer contains no credential');
    assert.equal(await absent(networkAudit), true, 'configuration makes no network request');
  });

  await t.test('private status uses only the scoped runner route and never prints the token', async () => {
    const result = run('status');
    noToken(result); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).generator.paired, true);
    assert.deepEqual(JSON.parse(await readFile(networkAudit, 'utf8')), { action: 'runnerMeta', scopedToken: true });
    await rm(networkAudit);
  });

  await t.test('adding a broad ACL principal is rejected before loading or forwarding the token', async () => {
    const tampered = command('icacls.exe', [secret, '/grant', '*S-1-1-0:(R)']);
    assert.equal(tampered.status, 0, tampered.stderr);
    try {
      const result = run('status');
      noToken(result); assert.equal(result.status, 1);
      assert.match(JSON.parse(result.stderr.trim()).message, /permissions are not private/);
      assert.equal(await absent(networkAudit), true, 'no fetch happens when credential permissions are unsafe');
    } finally {
      const restored = command('icacls.exe', [secret, '/remove:g', '*S-1-1-0']);
      assert.equal(restored.status, 0, restored.stderr);
    }
    assertPrivate(sddl(secret), expected);
  });

  await t.test('unsafe identity pointers are rejected before credential reads or fetch', async () => {
    for (const runnerId of ['../outside', '..\\outside', config.runnerId + '/..', '00000000-0000-1000-8000-000000000000']) {
      await writeFile(pointer, JSON.stringify({ version: 1, runnerId }));
      const result = run('status');
      noToken(result); assert.equal(result.status, 1);
      assert.match(JSON.parse(result.stderr.trim()).message, /Invalid connection identity/);
      assert.equal(await absent(networkAudit), true);
    }
    await writeFile(pointer, JSON.stringify({ version: 1, runnerId: config.runnerId }));
  });
});
