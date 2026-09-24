'use strict';

// Minimal static server for test/preview.html (serves the extension folder).
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || 8765);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Screenshots from test/shots.js: POST /save?name=<file>.png with a data: URL body.
    if (req.method === 'POST' && url.pathname === '/save') {
      const name = path.basename(url.searchParams.get('name') || '');
      if (!/^[\w-]+\.png$/.test(name)) {
        res.writeHead(400).end();
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const dataUrl = Buffer.concat(chunks).toString('utf8');
        fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(root, 'docs', name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
        res.writeHead(200).end('saved');
      });
      return;
    }
    const rel = url.pathname === '/' ? 'test/preview.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`preview: http://localhost:${port}/`));
