import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BACKEND_MESSAGE = 'AI generation, admin and saved settings need a connected backend. You can use local editing and export tools on this site.';

export function pagesRuntime() {
  return `window.craftushAPI = async function () {
    return new Response(JSON.stringify({ errors: [{ code: 'BACKEND_NOT_HOSTED', message: ${JSON.stringify(BACKEND_MESSAGE)} }] }), {
      status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  };
  document.addEventListener('DOMContentLoaded', function () {
    const notice = document.createElement('div');
    notice.id = 'hostingNotice';
    notice.setAttribute('role', 'status');
    notice.textContent = 'v17 · Local editing and exports are available. AI generation and admin need a connected backend.';
    notice.style.cssText = 'padding:12px 24px;background:#183326;color:#e6f7ec;border-bottom:1px solid #476451;font:14px/1.5 system-ui,sans-serif;text-align:center';
    document.body.prepend(notice);
    if (document.querySelector('#loginView')) {
      document.querySelectorAll('#loginView input, #loginView button').forEach(function (control) { control.disabled = true; });
    }
  });\n`;
}

export function adaptPagesText(text, basePath, extension) {
  const base = basePath + '/';
  text = text.replace(/fetch\((['"])\/api\//g, 'window.craftushAPI($1/api/');
  // Root-based links must stay inside this repository's GitHub Pages site.
  text = text.replace(/\b(href|src|action)=(["'])\/(?!\/)/g, '$1=$2' + base);
  text = text.replace(/(["'])\/(admin|visuals|documentary|chatgpt|comfy|thumbnail)(?=[\/\?#"'])/g, '$1' + base + '$2');
  text = text.replace(/url\((["']?)\/(?!\/)/g, 'url($1' + base);
  // A Pages site has no MCP endpoint. Do not copy the old Vercel endpoint into this build.
  text = text.replace(/<div class="setup-item"><div><strong>2\. Craftush<\/strong>.*?<\/button><\/div>/g,
    '<div class="setup-item"><div><strong>2. Craftush</strong><p class="help">Project connections need a separately hosted backend. No Craftush MCP server is connected on this site.</p></div></div>');
  text = text.replace(/https:\/\/craftush[^\s"'<>]*\.vercel\.app(?:\/[^\s"'<>]*)?/g, '[backend not connected]');
  if (extension === 'html') text = text.replace(/<head>/i, '<head>\n<script src="' + base + 'github-pages-runtime.js"></script>');
  return text;
}

export async function buildPages({ source = join(root, 'public'), destination = join(root, 'dist-pages'), basePath = process.env.PAGES_BASE_PATH || '/Craftush' } = {}) {
  if (!/^\/[A-Za-z0-9_-]+$/.test(basePath)) throw new Error('Use a single repository path, such as /Craftush.');
  if (resolve(source) === resolve(destination)) throw new Error('The Pages output must be separate from the source.');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(html|js|mjs|css|txt|json)$/.test(entry.name)) {
        const extension = entry.name.split('.').pop();
        const old = await readFile(path, 'utf8');
        const updated = adaptPagesText(old, basePath, extension);
        if (old !== updated) await writeFile(path, updated);
      }
    }
  }
  await visit(destination);
  await writeFile(join(destination, 'github-pages-runtime.js'), pagesRuntime());
  await writeFile(join(destination, '.nojekyll'), '');
  await mkdir(join(destination, 'thumbnail'), { recursive: true });
  await writeFile(join(destination, 'thumbnail/index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thumbnail Generator · Craftush</title><script src="' + basePath + '/github-pages-runtime.js"></script></head><body style="background:#10251a;color:#f2f5ef;font:18px/1.7 system-ui"><main style="max-width:680px;margin:80px auto;padding:24px"><h1>Thumbnail Generator</h1><p>This tool uses a generator uploaded in admin. A connected backend is required to load it.</p><a style="color:#a8dfaa" href="' + basePath + '/">Return to Craftush</a></main></body></html>');
  await writeFile(join(destination, 'hosting.json'), JSON.stringify({ version: '17', host: 'GitHub Pages', backendConnected: false, basePath }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPages();
  console.log('v17 GitHub Pages frontend prepared. Backend features require a separate service.');
}
