import fs from 'node:fs';
import path from 'node:path';

// Dev-only helper: POST a PNG data URL to /__capture?name=foo to write shots/foo.png
const capture = {
  name: 'capture',
  configureServer(server) {
    server.middlewares.use('/__capture', (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const b64 = body.replace(/^data:image\/\w+;base64,/, '');
        const url = new URL(req.url, 'http://localhost');
        const name = (url.searchParams.get('name') || 'shot').replace(/[^a-z0-9_-]/gi, '');
        const dir = path.resolve('shots');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(b64, 'base64'));
        res.end('ok');
      });
    });
  },
};

export default {
  plugins: [capture],
  server: { host: '127.0.0.1' },
};
