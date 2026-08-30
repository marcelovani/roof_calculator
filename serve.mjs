/**
 * The static site, plus one thing `python3 -m http.server` cannot do: save the
 * measurements back to data/cuts.json when they are typed into the page.
 *
 * Node's own http module, no dependencies, same as everything else here. Only
 * cuts.json can be written, only with something that parses as a cut list, and
 * the previous contents are kept alongside it — the measurements are hours of
 * work up a ladder and this is the one process that can overwrite them.
 *
 *   node serve.mjs [port]
 */

import { createServer } from 'node:http';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2]) || 8010;
const WRITABLE = '/data/cuts.json';
const MAX_BODY = 1_000_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

/** Inside the project or nowhere: no ../.. out of the served directory. */
function resolveInRoot(pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  const full = resolve(join(ROOT, clean === '/' ? 'index.html' : clean));
  return full === ROOT || full.startsWith(ROOT + sep) ? full : null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function save(req, res) {
  const target = resolveInRoot(WRITABLE);
  let text;
  try {
    text = await readBody(req);
  } catch {
    return send(res, 413, 'measurements too large to be real');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return send(res, 400, `not JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed.cuts !== 'object' || !Object.keys(parsed.cuts).length) {
    return send(res, 400, 'no cuts in that, refusing to overwrite the measurements');
  }

  // Previous contents first, then a write that either lands whole or not at all.
  await copyFile(target, `${target}.bak`).catch(() => {});
  const tmp = `${target}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, target);
  send(res, 200, 'saved');
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'PUT') {
    if (pathname !== WRITABLE) return send(res, 403, `only ${WRITABLE} can be saved`);
    try {
      return await save(req, res);
    } catch (err) {
      return send(res, 500, `could not save: ${err.message}`);
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'GET, HEAD or PUT');

  const file = resolveInRoot(pathname);
  if (!file) return send(res, 403, 'outside the project');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'not found');
  }
});

server.listen(PORT, () => {
  console.log(`roof cut planner on http://localhost:${PORT} — cuts.json is writable from the page`);
});
