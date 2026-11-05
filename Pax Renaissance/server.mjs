// Minimal static file server: node server.mjs [port]  ->  http://localhost:8080
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const port = +(process.argv[2] || process.env.PORT || 8080);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'application/x-ndjson; charset=utf-8', '.log': 'text/plain; charset=utf-8','.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = normalize(join(root, p));
  if (!f.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
  try { const data = await readFile(f); res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data); }
  catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, () => console.log(`Pax Renaissance running at http://localhost:${port}`));
