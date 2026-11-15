// Local preview server: `npm run dev` then open http://localhost:3000
// On Vercel you don't need this file — Vercel serves the static files and /api functions itself.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (path.startsWith('/api/')) {
        const name = path.slice(5).replace(/[^a-z0-9-]/gi, '');
        const mod = await import(join(root, 'api', name + '.js'));
        return await mod.default(req, res);
      }
      const file = normalize(join(root, path === '/' ? 'index.html' : path));
      if (!file.startsWith(root) || /(^|\/)(lib|api|scripts|node_modules)\//.test(file.slice(root.length))) throw new Error('nope');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  })
  .listen(PORT, () => console.log(`Font Explorer running at http://localhost:${PORT}`));
