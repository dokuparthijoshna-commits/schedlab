/* SchedLab server — zero dependencies (Node >= 16).
 *   node server.js            → http://localhost:3000
 *   PORT=8080 node server.js
 * Serves the static client from /public and exposes the same engine over a REST API.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const Sched = require('./public/scheduler.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const LIMITS = { maxProcesses: 5000, maxRuns: 200, maxSweepPoints: 40, maxBody: 5 * 1024 * 1024 };

/* ---------- tiny persistence layer for saved runs ---------- */
function readRuns() {
  try { return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); } catch (e) { return []; }
}
function writeRuns(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RUNS_FILE, JSON.stringify(list, null, 1));
}

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > LIMITS.maxBody) { reject(new HttpError(413, 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new HttpError(400, 'Body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}
function needAlgos(list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Choose at least one algorithm.');
  list.forEach(function (a) { if (!Sched.ALGOS[a]) throw new HttpError(400, 'Unknown algorithm: ' + a); });
  return list;
}
function clampWorkload(w) {
  w = w || {};
  if (w.n > LIMITS.maxProcesses) throw new HttpError(400, 'Too many processes (max ' + LIMITS.maxProcesses + ').');
  return w;
}

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': function () {
    return { ok: true, engine: 'schedlab', node: process.version, uptime: Math.round(process.uptime()), algorithms: Object.keys(Sched.ALGOS).length };
  },
  'GET /api/algorithms': function () {
    return {
      algorithms: Object.keys(Sched.ALGOS).map(function (id) { return { id: id, label: Sched.ALGOS[id].label, preemptive: Sched.ALGOS[id].preemptive }; }),
      metrics: Sched.METRICS, defaults: { config: Sched.DEFAULT_CFG, workload: Sched.DEFAULT_WL }
    };
  },
  'GET /api/selftest': function () {
    const tests = Sched.selfTests();
    return { passed: tests.filter(function (t) { return t.pass; }).length, total: tests.length, tests: tests };
  },
  'POST /api/workload': function (b) {
    return { processes: Sched.generateWorkload(clampWorkload(b.params)) };
  },
  'POST /api/simulate': function (b) {
    needAlgos([b.algorithm]);
    if (!Array.isArray(b.processes)) throw new HttpError(400, '"processes" must be an array.');
    if (b.processes.length > LIMITS.maxProcesses) throw new HttpError(400, 'Too many processes.');
    return Sched.simulate(b.algorithm, b.processes, b.config, { trace: b.trace !== false });
  },
  'POST /api/compare': function (b) {
    needAlgos(b.algorithms);
    if (b.runs > LIMITS.maxRuns) throw new HttpError(400, 'Too many runs (max ' + LIMITS.maxRuns + ').');
    return Sched.compare(b.algorithms, clampWorkload(b.workload), b.config, b.runs, b.baseSeed);
  },
  'POST /api/sweep': function (b) {
    needAlgos(b.algorithms);
    if (!Array.isArray(b.values) || !b.values.length || b.values.length > LIMITS.maxSweepPoints) throw new HttpError(400, 'Sweep needs 1–' + LIMITS.maxSweepPoints + ' values.');
    if (!Sched.METRICS.some(function (m) { return m.key === b.metric; })) throw new HttpError(400, 'Unknown metric.');
    if (b.runs > LIMITS.maxRuns) throw new HttpError(400, 'Too many runs.');
    return Sched.sweep(b.algorithms, clampWorkload(b.workload), b.config, b.param, b.values.map(Number), b.runs || 10, b.baseSeed, b.metric);
  },
  'GET /api/runs': function () {
    return { runs: readRuns().map(function (r) { return { id: r.id, name: r.name, algorithm: r.algorithm, savedAt: r.savedAt, n: r.processes.length, metrics: r.metrics }; }) };
  },
  'POST /api/runs': function (b) {
    if (!b.algorithm || !Array.isArray(b.processes)) throw new HttpError(400, 'Nothing to save.');
    const list = readRuns();
    const run = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(b.name || 'Untitled run').slice(0, 80), savedAt: new Date().toISOString(),
      algorithm: b.algorithm, config: b.config || {}, processes: b.processes, metrics: b.metrics || {}
    };
    list.unshift(run);
    writeRuns(list.slice(0, 100));
    return { id: run.id };
  }
};

function handleApi(req, res, url) {
  const key = req.method + ' ' + url.pathname;
  // /api/runs/:id
  const m = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const run = readRuns().find(function (r) { return r.id === m[1]; });
    if (!run) throw new HttpError(404, 'Run not found.');
    return send(res, 200, run);
  }
  if (m && req.method === 'DELETE') {
    const list = readRuns(); const next = list.filter(function (r) { return r.id !== m[1]; });
    if (next.length === list.length) throw new HttpError(404, 'Run not found.');
    writeRuns(next); return send(res, 200, { deleted: m[1] });
  }
  const fn = routes[key];
  if (!fn) throw new HttpError(404, 'No such endpoint: ' + key);
  if (req.method === 'POST') {
    return readBody(req).then(function (body) {
      const t0 = process.hrtime.bigint();
      const out = fn(body);
      out.serverMs = Number(process.hrtime.bigint() - t0) / 1e6;
      send(res, 200, out);
    });
  }
  const out = fn();
  send(res, 200, out);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const root = path.resolve(PUBLIC);
  const rel = p.replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  const relPath = path.relative(root, file);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  const fail = function (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('request failed:', e.message); send(res, 400, { error: e.message || 'Server error' });
  };
  try {
    if (url.pathname.startsWith('/api/')) {
      const r = handleApi(req, res, url);
      if (r && r.catch) r.catch(fail);
    } else serveStatic(req, res, url);
  } catch (e) { fail(e); }
});

if (require.main === module) {
  server.listen(PORT, function () { console.log('SchedLab running → http://localhost:' + PORT); });
}
module.exports = server;
