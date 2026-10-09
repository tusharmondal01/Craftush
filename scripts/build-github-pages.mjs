import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeBackendURL, pagesRuntime } from './pages-runtime.mjs';
export { BACKEND_MESSAGE, pagesRuntime } from './pages-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function adaptPagesText(text, basePath, extension, backendURL = '') {
  const base = basePath + '/';
  text = text.replace(/fetch\((['"])\/api\//g, 'window.craftushAPI($1/api/');
  // Root-based links must stay inside this repository's GitHub Pages site.
  text = text.replace(/\b(href|src|action)=(["'])\/(?!\/)/g, '$1=$2' + base);
  text = text.replace(/(["'])\/(admin|visuals|documentary|chatgpt|comfy|thumbnail)(?=[\/\?#"'])/g, '$1' + base + '$2');
  text = text.replace(/url\((["']?)\/(?!\/)/g, 'url($1' + base);
  // Connected builds advertise their actual MCP service, never an old host.
  if (!backendURL) text = text.replace(/<div class="setup-item"><div><strong>2\. Craftush<\/strong>.*?<\/button><\/div>/g,
    '<div class="setup-item"><div><strong>2. Craftush</strong><p class="help">Project connections need a separately hosted backend. No Craftush MCP server is connected on this site.</p></div></div>');
  text = text.replace(/https:\/\/craftush[^\s"'<>]*\.vercel\.app(?:\/[^\s"'<>]*)?/g,
    value => backendURL ? backendURL + new URL(value).pathname : '[backend not connected]');
  if (extension === 'html') text = text.replace(/<head>/i, '<head>\n<script src="' + base + 'github-pages-runtime.js"></script>');
  return text;
}

export async function buildPages({ source = join(root, 'public'), destination = join(root, 'dist-pages'), basePath = process.env.PAGES_BASE_PATH || '/Craftush', backendURL = process.env.PAGES_API_BASE || '' } = {}) {
  if (!/^\/[A-Za-z0-9_-]+$/.test(basePath)) throw new Error('Use a single repository path, such as /Craftush.');
  if (resolve(source) === resolve(destination)) throw new Error('The Pages output must be separate from the source.');
  backendURL = normalizeBackendURL(backendURL);
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
        const updated = adaptPagesText(old, basePath, extension, backendURL);
        if (old !== updated) await writeFile(path, updated);
      }
    }
  }
  await visit(destination);
  await writeFile(join(destination, 'github-pages-runtime.js'), pagesRuntime({ backendURL }));
  await writeFile(join(destination, '.nojekyll'), '');
  await mkdir(join(destination, 'thumbnail'), { recursive: true });
  const thumbnailScript = backendURL ? '<script>location.replace(' + JSON.stringify(backendURL + '/thumbnail') + ');</script>' : '';
  await writeFile(join(destination, 'thumbnail/index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thumbnail Generator · Craftush</title><script src="' + basePath + '/github-pages-runtime.js"></script>' + thumbnailScript + '</head><body style="background:#10251a;color:#f2f5ef;font:18px/1.7 system-ui"><main style="max-width:680px;margin:80px auto;padding:24px"><h1>Thumbnail Generator</h1><p>' + (backendURL ? 'Opening your thumbnail generator…' : 'This tool uses a generator uploaded in admin. A connected backend is required to load it.') + '</p><a style="color:#a8dfaa" href="' + basePath + '/">Return to Craftush</a></main></body></html>');
  await writeFile(join(destination, 'hosting.json'), JSON.stringify({ version: '17', host: 'GitHub Pages', backendConnected: !!backendURL, backendURL, basePath }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPages();
  console.log('v17 GitHub Pages frontend prepared. Backend features require a separate service.');
}

