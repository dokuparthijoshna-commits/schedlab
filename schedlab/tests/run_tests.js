/* npm test — engine self-tests + live API tests against an ephemeral server */
'use strict';
const http = require('http');
const Sched = require('../public/scheduler.js');
const server = require('../server.js');

let failed = 0;
function report(name, ok, detail) { if (!ok) failed++; console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  (' + detail + ')' : '')); }

console.log('Engine');
Sched.selfTests().forEach(t => report(t.name, t.pass, t.detail));

function call(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { j = s; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

server.listen(0, async () => {
  const port = server.address().port;
  console.log('\nServer API (port ' + port + ')');
  try {
    let r = await call(port, 'GET', '/api/health'); report('GET /api/health', r.status === 200 && r.body.ok);
    r = await call(port, 'GET', '/'); report('GET / serves the client', r.status === 200 && /SchedLab/.test(r.body));
    r = await call(port, 'GET', '/scheduler.js'); report('GET /scheduler.js (shared engine)', r.status === 200);
    r = await call(port, 'GET', '/../server.js'); report('Path traversal blocked', r.status !== 200 || !/createServer/.test(r.body));

    const ex = [{ pid: 'P1', arrival: 0, bursts: '5' }, { pid: 'P2', arrival: 2, bursts: '3' }, { pid: 'P3', arrival: 4, bursts: '8' }];
    r = await call(port, 'POST', '/api/simulate', { algorithm: 'RR', config: { quantum: 3 }, processes: ex });
    report('POST /api/simulate (RR q=3 → CT 8,6,16)', r.status === 200 && JSON.stringify(r.body.processes.map(p => p.completion)) === '[8,6,16]');
    const local = Sched.simulate('RR', ex, { quantum: 3 }, { trace: true });
    report('Server result equals browser result', JSON.stringify(local.metrics) === JSON.stringify(r.body.metrics));

    r = await call(port, 'POST', '/api/simulate', { algorithm: 'NOPE', processes: ex }); report('Unknown algorithm → 400', r.status === 400);
    r = await call(port, 'POST', '/api/simulate', { algorithm: 'FCFS', processes: [] }); report('Empty process list → 400 with message', r.status === 400 && /process/i.test(r.body.error));
    r = await call(port, 'POST', '/api/workload', { params: { n: 12, seed: 5 } }); report('POST /api/workload', r.status === 200 && r.body.processes.length === 12);
    r = await call(port, 'POST', '/api/compare', { algorithms: ['FCFS', 'RR', 'SRTF'], workload: { n: 30 }, config: { quantum: 4 }, runs: 10, baseSeed: 1 });
    report('POST /api/compare', r.status === 200 && r.body.results.SRTF.avgWT.samples.length === 10);
    report('SRTF beats FCFS on mean waiting time', r.body.results.SRTF.avgWT.mean < r.body.results.FCFS.avgWT.mean);
    r = await call(port, 'POST', '/api/sweep', { algorithms: ['RR'], workload: { n: 20 }, config: {}, param: 'quantum', values: [1, 2, 4], runs: 5, metric: 'ctxSwitches' });
    report('POST /api/sweep (smaller quantum → more switches)', r.status === 200 && r.body.series[0].points[0].mean > r.body.series[0].points[2].mean);
    r = await call(port, 'POST', '/api/compare', { algorithms: ['RR'], runs: 99999 }); report('Run limit enforced', r.status === 400);
    r = await call(port, 'GET', '/api/selftest'); report('GET /api/selftest', r.status === 200 && r.body.passed === r.body.total);
    r = await call(port, 'GET', '/api/nothing'); report('Unknown endpoint → 404', r.status === 404);
  } catch (e) { report('API tests crashed', false, e.message); }
  server.close();
  console.log(failed ? '\n' + failed + ' FAILED' : '\nAll tests passed');
  process.exit(failed ? 1 : 0);
});
