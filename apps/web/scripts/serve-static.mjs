import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../out/', import.meta.url)));
const port = Number(process.argv[2] ?? 3100);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(
      new URL(request.url, 'http://localhost').pathname,
    );
    const candidates =
      path === '/'
        ? ['index.html']
        : [
            `${path.slice(1)}.html`,
            path.slice(1),
            join(path.slice(1), 'index.html'),
          ];
    for (const candidate of candidates) {
      const file = resolve(root, candidate);
      if (!file.startsWith(root + sep)) continue;
      if (!(await stat(file).catch(() => null))?.isFile()) continue;
      response.setHeader(
        'Content-Type',
        mime[extname(file)] ?? 'application/octet-stream',
      );
      response.setHeader('Cache-Control', 'no-store');
      createReadStream(file).pipe(response);
      return;
    }
    response.writeHead(404).end('Not found');
  } catch {
    response.writeHead(400).end('Bad request');
  }
}).listen(port, '127.0.0.1');
