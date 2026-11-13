(function () {
  'use strict';
  const S = window.Sched;
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  const tick = function () { return new Promise(function (r) { setTimeout(r, 15); }); };
  const esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const cssv = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };

  const state = { mode: 'client', serverUp: false, procs: [], result: null, cmp: null, redraw: {}, play: null };
  const SHORT = { FCFS: 'FCFS', SJF: 'SJF', SRTF: 'SRTF', RR: 'RR', PRIO_NP: 'Prio-NP', PRIO_P: 'Prio-P', MLQ: 'MLQ', MLFQ: 'MLFQ', EDF: 'EDF', LOTTERY: 'Lottery', FAIR: 'Fair' };
  const ALGO_COLORS = ['#2d5be3', '#e0702b', '#1b9e77', '#c43d8c', '#8a6bd1', '#b8941c', '#0e9bb5', '#d1495b', '#5b8c2a', '#7a5c3e', '#4a6fa5'];
  const ALGO_IDS = Object.keys(S.ALGOS);
  const algoColor = function (id) { return ALGO_COLORS[ALGO_IDS.indexOf(id) % ALGO_COLORS.length]; };
  const procColor = function (i) { return 'hsl(' + ((i * 137.5 + 215) % 360).toFixed(0) + ' 58% 42%)'; };

  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    const a = Math.abs(v);
    if (d !== undefined) return v.toFixed(d);
    if (v === 0) return '0';
    return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
  }
  const mfmt = function (m, v) { return m.pct ? (v * 100).toFixed(1) + '%' : fmt(v); };

  function toast(msg, err) {
    const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; t.setAttribute('role', 'status');
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, err ? 6000 : 3500);
  }

  /* ============================================================ ENGINE ROUTER
   * Server mode → POST to the API (falls back to the in-browser engine if the server is unreachable).
   * Browser mode → run scheduler.js right here. Same code, same results.                         */
  function setBadge(where, ms, serverMs) {
    const txt = where === 'server' ? 'computed on server · ' + ms.toFixed(0) + ' ms round-trip' + (serverMs != null ? ' (engine ' + serverMs.toFixed(0) + ' ms)' : '') : 'computed in browser · ' + ms.toFixed(0) + ' ms';
    $$('.engine-badge').forEach(function (b) { b.textContent = txt; });
  }
  async function api(path, body, local) {
    if (state.mode === 'server' && state.serverUp) {
      try {
        const t0 = performance.now();
        const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let j; try { j = await r.json(); } catch (e) { throw new TypeError('bad response'); }
        if (!r.ok) { const err = new Error(j.error || 'Server error'); err.api = true; throw err; }
        setBadge('server', performance.now() - t0, j.serverMs); return j;
      } catch (e) {
        if (e.api) throw e;
        state.serverUp = false; state.mode = 'client'; updateEngineUI();
        toast('Server unreachable — switched to the browser engine.', true);
      }
    }
    const t0 = performance.now(); await tick(); const j = local(); setBadge('browser', performance.now() - t0); return j;
  }
  function updateEngineUI() {
    $('#modeClient').setAttribute('aria-pressed', state.mode === 'client');
    $('#modeServer').setAttribute('aria-pressed', state.mode === 'server');
    $('#modeServer').disabled = !state.serverUp;
    $('#srvDot').className = 'dot ' + (state.serverUp ? 'on' : 'off');
    $('#srvText').textContent = state.serverUp ? 'server online' : 'no server (static mode)';
    $('#btnSave').disabled = !state.serverUp || !state.result;
    $('#btnTestServer').disabled = !state.serverUp;
  }
  async function probeServer() {
    if (!/^https?:$/.test(location.protocol)) return updateEngineUI();
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.ok) { state.serverUp = true; state.mode = 'server'; }
    } catch (e) { /* static hosting — fine */ }
    updateEngineUI();
  }
  function busy(b) { $$('.btn.primary').forEach(function (x) { x.disabled = b; }); }

  /* ============================================================ FORMS */
  function readCfg() {
    const n = function (id) { return +$('#' + id).value || 0; };
    return { quantum: Math.max(1, n('quantum')), csCost: n('csCost'), aging: n('aging'), levels: Math.max(1, n('levels')), boost: n('boost'), seed: n('seed') };
  }
  function readWl() {
    const n = function (id) { return +$('#w_' + id).value; };
    return {
      n: n('n'), seed: n('seed'), arrivalMode: $('#w_arrivalMode').value, arrivalRate: n('arrivalRate'), burstDist: $('#w_burstDist').value,
      ioFraction: n('ioFraction'), cpuBurstMean: n('cpuBurstMean'), ioBurstMean: n('ioBurstMean'), ioTimeMean: n('ioTimeMean'),
      priorityLevels: Math.max(1, n('priorityLevels')), users: Math.max(1, n('users')), deadlineSlack: n('deadlineSlack')
    };
  }
  function updateLoadHint() {
    const w = readWl(); $('#ioFracVal').textContent = Math.round(w.ioFraction * 100) + '%';
    const rho = S.estimateLoad(w);
    $('#loadEst').textContent = rho === null ? 'All processes arrive at t=0 (batch).' :
      'Estimated CPU load ρ ≈ ' + rho.toFixed(2) + (rho > 1 ? ' — overloaded: queues keep growing' : rho > 0.8 ? ' — heavily loaded' : ' — light to moderate');
  }
  function updateVisibility() {
    const a = $('#algo').value;
    $$('[data-for]').forEach(function (el) { el.hidden = el.getAttribute('data-for').split(' ').indexOf(a) < 0; });
    const info = INFO.find(function (i) { return i.id === a; });
    $('#algoHint').textContent = info ? info.short : '';
  }

  /* ============================================================ EXAMPLES */
  const P = function (pid, at, bursts, extra) { return Object.assign({ pid: pid, arrival: at, bursts: bursts, priority: 0, deadline: null, tickets: 10, user: 'U1' }, extra || {}); };
  const EXAMPLES = {
    doc: { label: 'Worked example from the brief (P1, P2, P3)', algo: 'FCFS', q: 3, procs: [P('P1', 0, '5'), P('P2', 2, '3'), P('P3', 4, '8')] },
    convoy: { label: 'Convoy effect (one long job first)', algo: 'FCFS', q: 3, procs: [P('P1', 0, '30'), P('P2', 1, '2'), P('P3', 2, '2'), P('P4', 3, '3'), P('P5', 4, '1')] },
    prio: { label: 'Priority & starvation', algo: 'PRIO_P', q: 3, procs: [P('P1', 0, '6', { priority: 3 }), P('P2', 0, '4', { priority: 1 }), P('P3', 1, '3', { priority: 0 }), P('P4', 2, '5', { priority: 0 }), P('P5', 3, '2', { priority: 2 }), P('P6', 9, '4', { priority: 0 })] },
    io: { label: 'CPU-bound vs I/O-bound mix', algo: 'MLFQ', q: 2, procs: [P('CPU1', 0, '20', { priority: 3 }), P('IO1', 0, '2,5,2,5,2,5,2', { priority: 1 }), P('IO2', 1, '2,4,2,4,2,4,2,4,2', { priority: 1 }), P('CPU2', 3, '15', { priority: 3 })] },
    edf: { label: 'Real-time deadlines (EDF)', algo: 'EDF', q: 3, procs: [P('T1', 0, '3', { deadline: 7 }), P('T2', 1, '2', { deadline: 5 }), P('T3', 2, '4', { deadline: 14 }), P('T4', 4, '1', { deadline: 6 })] },
    fair: { label: 'Fair-share: user U1 runs 4 jobs, U2 runs 1', algo: 'FAIR', q: 2, procs: [P('A1', 0, '6', { user: 'U1' }), P('A2', 0, '6', { user: 'U1' }), P('A3', 0, '6', { user: 'U1' }), P('A4', 0, '6', { user: 'U1' }), P('B1', 0, '6', { user: 'U2' })] }
  };
  function loadExample(key) {
    const ex = EXAMPLES[key]; if (!ex) return;
    state.procs = JSON.parse(JSON.stringify(ex.procs)); $('#algo').value = ex.algo; $('#quantum').value = ex.q; updateVisibility(); renderProcs();
  }

  /* ============================================================ PROCESS EDITOR */
  const COLS = [['pid', 'PID', 'text'], ['arrival', 'Arrival', 'number'], ['bursts', 'Bursts (cpu,io,cpu…)', 'text'], ['priority', 'Priority', 'number'], ['deadline', 'Deadline', 'number'], ['tickets', 'Tickets', 'number'], ['user', 'User', 'text']];
  function renderProcs() {
    $('#procCount').textContent = state.procs.length;
    const rows = state.procs.slice(0, 150).map(function (p, i) {
      return '<tr>' + COLS.map(function (c) {
        let v = p[c[0]]; if (c[0] === 'bursts' && Array.isArray(v)) v = v.join(','); if (v === null || v === undefined) v = '';
        return '<td class="' + (c[0] === 'pid' ? 'l' : '') + '"><input class="' + (c[0] === 'bursts' ? 'bursts' : '') + '" data-i="' + i + '" data-f="' + c[0] + '" type="' + (c[2] === 'number' ? 'number' : 'text') + '" value="' + esc(v) + '" aria-label="' + c[1] + ' of row ' + (i + 1) + '"></td>';
      }).join('') + '<td><button class="btn sm ghost" data-del="' + i + '" aria-label="Remove row ' + (i + 1) + '">✕</button></td></tr>';
    }).join('');
    $('#procTbl').innerHTML = '<thead><tr>' + COLS.map(function (c) { return '<th class="' + (c[0] === 'pid' ? 'l' : '') + '">' + c[1] + '</th>'; }).join('') + '<th></th></tr></thead><tbody>' + rows + '</tbody>' +
      (state.procs.length > 150 ? '<caption class="small muted">Showing the first 150 of ' + state.procs.length + ' processes (all are simulated).</caption>' : '');
  }
  function bindProcEditor() {
    $('#procTbl').addEventListener('change', function (e) {
      const t = e.target; if (!t.dataset || t.dataset.i === undefined) return;
      const p = state.procs[+t.dataset.i], f = t.dataset.f;
      p[f] = (t.type === 'number') ? (t.value === '' ? null : +t.value) : t.value;
    });
    $('#procTbl').addEventListener('click', function (e) {
      const b = e.target.closest('[data-del]'); if (!b) return; state.procs.splice(+b.dataset.del, 1); renderProcs();
    });
    $('#btnAddProc').onclick = function () {
      const last = state.procs[state.procs.length - 1];
      state.procs.push(P('P' + (state.procs.length + 1), last ? last.arrival + 1 : 0, '5')); renderProcs();
    };
    $('#btnClear').onclick = function () { state.procs = []; renderProcs(); };
    $('#btnExpJson').onclick = function () { download('processes.json', JSON.stringify(S.normalize(state.procs), null, 1), 'application/json'); };
    $('#btnImpJson').onclick = function () { $('#fileJson').click(); };
    $('#fileJson').onchange = function (e) {
      const f = e.target.files[0]; if (!f) return;
      f.text().then(function (txt) {
        const arr = JSON.parse(txt); if (!Array.isArray(arr)) throw new Error('JSON must be an array of processes.');
        state.procs = arr; renderProcs(); toast('Imported ' + arr.length + ' processes.');
      }).catch(function (err) { toast('Import failed: ' + err.message, true); });
      e.target.value = '';
    };
  }
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  }

  /* ============================================================ SIMULATE */
  async function generate() {
    busy(true);
    try {
      const wl = readWl();
      const j = await api('/api/workload', { params: wl }, function () { return { processes: S.generateWorkload(wl) }; });
      state.procs = j.processes; renderProcs(); $('#example').value = '';
      toast('Generated ' + j.processes.length + ' processes.');
    } catch (e) { toast(e.message, true); } finally { busy(false); }
  }
  async function runSim() {
    if (!state.procs.length) return toast('Add or generate some processes first.', true);
    const algo = $('#algo').value, cfg = readCfg();
    busy(true);
    try {
      const res = await api('/api/simulate', { algorithm: algo, config: cfg, processes: state.procs, trace: true }, function () { return S.simulate(algo, state.procs, cfg, { trace: true }); });
      state.result = res; renderSim(res); updateEngineUI();
    } catch (e) { toast(e.message, true); } finally { busy(false); }
  }
  function renderSim(res) {
    const m = res.metrics;
    const hasDl = res.processes.some(function (p) { return p.deadline != null; });
    const tiles = [
      ['Avg turnaround', fmt(m.avgTAT)], ['Avg waiting', fmt(m.avgWT)], ['Avg response', fmt(m.avgRT)],
      ['Throughput (proc/tick)', fmt(m.throughput)], ['CPU utilization', (m.cpuUtil * 100).toFixed(1) + '%'], ['Fairness (Jain)', fmt(m.jain)],
      ['Context switches', m.ctxSwitches], ['Makespan', m.makespan], ['Max wait', m.maxWT], ['95th pct wait', m.p95WT],
      ['Waited > ' + res.config.starveThreshold, m.starved]
    ];
    if (hasDl) tiles.push(['Deadline misses', m.deadlineMisses]);
    if (res.config.csCost > 0) tiles.push(['Switch overhead (ticks)', m.csTicks]);
    $('#tiles').innerHTML = tiles.map(function (t) { return '<div class="tile"><b>' + t[1] + '</b><span>' + t[0] + '</span></div>'; }).join('');
    $('#simEmpty').hidden = true; $('#simOut').hidden = false; $('#ganttCard').hidden = false; $('#resCard').hidden = false; $('#btnCsv').disabled = false;

    // process table
    const head = ['PID', 'User', 'Arrival', 'CPU', 'I/O', 'Prio', 'First run', 'Done', 'Turnaround', 'Waiting', 'Response', 'Share'];
    if (hasDl) head.push('Deadline');
    const avg = function (k) { return fmt(S.stats.mean(res.processes.map(function (p) { return p[k]; }))); };
    $('#resTbl').innerHTML = '<thead><tr>' + head.map(function (h, i) { return '<th class="' + (i < 2 ? 'l' : '') + '">' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      res.processes.map(function (p, i) {
        return '<tr><td><span class="pill" style="background:' + procColor(i) + '">' + esc(p.pid) + '</span></td><td class="l">' + esc(p.user) + '</td><td>' + p.arrival + '</td><td>' + p.cpu + '</td><td>' + p.io + '</td><td>' + p.priority + '</td><td>' + p.firstStart + '</td><td>' + p.completion + '</td><td>' + p.tat + '</td><td>' + p.wait + '</td><td>' + p.response + '</td><td>' + (p.share * 100).toFixed(0) + '%</td>' +
          (hasDl ? '<td style="color:' + (p.missed ? 'var(--bad)' : 'var(--ok)') + '">' + (p.deadline == null ? '–' : p.deadline + (p.missed ? ' ✗ missed' : ' ✓')) + '</td>' : '') + '</tr>';
      }).join('') + '</tbody><tfoot><tr><td class="l"><b>Average</b></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td><b>' + avg('tat') + '</b></td><td><b>' + avg('wait') + '</b></td><td><b>' + avg('response') + '</b></td><td></td>' + (hasDl ? '<td></td>' : '') + '</tr></tfoot>';

    const T = m.makespan; $('#zoom').value = Math.max(1, Math.min(40, Math.floor(900 / Math.max(T, 1)))); 
    $('#scrub').max = T; $('#scrub').value = 0; stopPlay();
    drawGantt(); setScrub(0);
  }

  /* ---------- Gantt ---------- */
  function drawGantt() {
    const res = state.result; if (!res) return;
    const T = res.metrics.makespan, px = +$('#zoom').value, W = T * px + 48, H = 128;
    const ids = {}; res.processes.forEach(function (p, i) { ids[p.pid] = i; });
    let step = 1; [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].some(function (s) { step = s; return s * px >= 38; });
    const ink = cssv('--ink'), muted = cssv('--muted');
    let svg = '<svg width="' + W + '" height="' + H + '" role="img" aria-label="Gantt chart"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="' + cssv('--paper') + '"/><rect width="2.5" height="6" fill="' + muted + '"/></pattern></defs>';
    for (let t = 0; t <= T; t += step) svg += '<line x1="' + (24 + t * px) + '" x2="' + (24 + t * px) + '" y1="22" y2="30" stroke="' + muted + '"/><text x="' + (24 + t * px) + '" y="16" font-size="11" fill="' + muted + '" text-anchor="middle">' + t + '</text>';
    res.gantt.forEach(function (g) {
      const x = 24 + g.start * px, w = (g.end - g.start) * px;
      if (g.kind === 'run') {
        svg += '<g><title>' + esc(g.pid) + ': ' + g.start + ' → ' + g.end + '</title><rect x="' + x + '" y="32" width="' + Math.max(w - 1, 0.5) + '" height="52" rx="3" fill="' + procColor(ids[g.pid]) + '"/>' + (w >= 20 ? '<text x="' + (x + w / 2) + '" y="63" fill="#fff" font-size="12" font-weight="600" text-anchor="middle">' + esc(g.pid.length > w / 7 ? g.pid.slice(0, Math.max(1, Math.floor(w / 7))) : g.pid) + '</text>' : '') + '</g>';
      } else if (g.kind === 'cs') svg += '<rect x="' + x + '" y="32" width="' + w + '" height="52" fill="url(#hatch)"><title>context switch</title></rect>';
      else svg += '<rect x="' + (x + .5) + '" y="32.5" width="' + Math.max(w - 1, 0) + '" height="51" rx="3" fill="none" stroke="' + muted + '" stroke-dasharray="3 3"><title>idle ' + g.start + '–' + g.end + '</title></rect>';
    });
    if (res.processes.length <= 40) res.processes.forEach(function (p, i) {
      const x = 24 + p.arrival * px; svg += '<path d="M' + (x - 4) + ' 98 L' + (x + 4) + ' 98 L' + x + ' 91 Z" fill="' + procColor(i) + '"/>' + (px * 1 >= 4 || res.processes.length <= 12 ? '<text x="' + x + '" y="111" font-size="9.5" fill="' + muted + '" text-anchor="middle">' + esc(p.pid) + '</text>' : '');
    });
    svg += '<line id="cursor" x1="24" x2="24" y1="20" y2="90" stroke="' + cssv('--accent') + '" stroke-width="2"/></svg>';
    $('#gantt').innerHTML = svg; setScrub(+$('#scrub').value);
  }
  function setScrub(t) {
    const res = state.result; if (!res) return;
    const px = +$('#zoom').value, T = res.metrics.makespan; t = Math.max(0, Math.min(T, t));
    const c = $('#cursor'); if (c) { c.setAttribute('x1', 24 + t * px); c.setAttribute('x2', 24 + t * px); }
    $('#scrub').value = t; $('#scrubT').textContent = 't = ' + t;
    const wrap = $('#gantt'), cx = 24 + t * px; if (cx < wrap.scrollLeft + 20 || cx > wrap.scrollLeft + wrap.clientWidth - 20) wrap.scrollLeft = cx - wrap.clientWidth / 2;
    // binary search the queue log
    const q = res.qlog; let lo = 0, hi = q.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (q[mid].t <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    const ids = {}; res.processes.forEach(function (p, i) { ids[p.pid] = i; });
    const pill = function (pid) { return '<span class="pill" style="background:' + procColor(ids[pid]) + '">' + esc(pid) + '</span>'; };
    if (t >= T) { $('#stRun').innerHTML = '<span class="muted">all done</span>'; $('#stReady').innerHTML = ''; $('#stIo').innerHTML = ''; return; }
    const e = k >= 0 ? q[k] : { run: null, ready: [], io: [] };
    $('#stRun').innerHTML = e.run ? pill(e.run) : '<span class="muted">idle / switching</span>';
    $('#stReady').innerHTML = e.ready.length ? e.ready.slice(0, 40).map(pill).join('') + (e.ready.length > 40 ? ' …+' + (e.ready.length - 40) : '') : '<span class="muted">empty</span>';
    $('#stIo').innerHTML = e.io.length ? e.io.slice(0, 40).map(pill).join('') : '<span class="muted">none</span>';
  }
  function stopPlay() { if (state.play) { clearInterval(state.play); state.play = null; } $('#btnPlay').textContent = '▶ Play'; }
  function togglePlay() {
    if (state.play) return stopPlay();
    const T = state.result.metrics.makespan, inc = Math.max(1, Math.round(T / 150));
    if (+$('#scrub').value >= T) setScrub(0);
    $('#btnPlay').textContent = '❚❚ Pause';
    state.play = setInterval(function () { const n = +$('#scrub').value + inc; setScrub(n); if (n >= T) stopPlay(); }, 70);
  }
  function exportCsv() {
    const r = state.result; if (!r) return;
    const cols = ['pid', 'user', 'arrival', 'cpu', 'io', 'priority', 'firstStart', 'completion', 'tat', 'wait', 'response', 'share'];
    download('results-' + r.algorithm + '.csv', cols.join(',') + '\n' + r.processes.map(function (p) { return cols.map(function (c) { return p[c]; }).join(','); }).join('\n'), 'text/csv');
  }
  async function saveRun() {
    const r = state.result; if (!r) return;
    const name = prompt('Name this run:', r.label + ' · ' + r.processes.length + ' processes'); if (!name) return;
    try {
      const resp = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, algorithm: r.algorithm, config: r.config, processes: state.procs, metrics: r.metrics }) });
      const j = await resp.json(); if (!resp.ok) throw new Error(j.error);
      toast('Saved on the server.');
    } catch (e) { toast('Could not save: ' + e.message, true); }
  }

  /* ============================================================ CHARTS */
  function prep(c, h) {
    const dpr = window.devicePixelRatio || 1, w = Math.max(220, c.parentNode.clientWidth - (c.parentNode.classList.contains('chart-card') ? 24 : 32));
    c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px';
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); g.font = '11px ' + cssv('--sans'); return { g: g, w: w, h: h };
  }
  function niceMax(v) { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; }
  function axisLabel(v, pct) { return pct ? Math.round(v * 100) + '%' : (Math.abs(v) >= 100 ? v.toFixed(0) : fmt(v)); }
  function barChart(c, items, o) {
    const q = prep(c, 210), g = q.g, L = 46, R = 8, T = 10, B = 28, ink = cssv('--ink'), muted = cssv('--muted'), grid = cssv('--line-soft');
    let mx = 0; items.forEach(function (i) { mx = Math.max(mx, i.mean + i.ci); }); mx = niceMax(mx * 1.04) || 1;
    g.textAlign = 'right'; g.fillStyle = muted;
    for (let k = 0; k <= 4; k++) { const y = T + (q.h - T - B) * (1 - k / 4); g.strokeStyle = grid; g.beginPath(); g.moveTo(L, y); g.lineTo(q.w - R, y); g.stroke(); g.fillText(axisLabel(mx * k / 4, o.pct), L - 5, y + 4); }
    const bw = (q.w - L - R) / items.length;
    items.forEach(function (it, i) {
      const x = L + i * bw + bw * .2, w = bw * .6, hh = (q.h - T - B) * (it.mean / mx), y = q.h - B - hh;
      g.fillStyle = it.color; g.fillRect(x, y, w, hh);
      if (it.ci > 0) { const y1 = q.h - B - (q.h - T - B) * ((it.mean + it.ci) / mx), y2 = q.h - B - (q.h - T - B) * (Math.max(0, it.mean - it.ci) / mx), cx = x + w / 2; g.strokeStyle = ink; g.lineWidth = 1.4; g.beginPath(); g.moveTo(cx, y1); g.lineTo(cx, y2); g.moveTo(cx - 4, y1); g.lineTo(cx + 4, y1); g.moveTo(cx - 4, y2); g.lineTo(cx + 4, y2); g.stroke(); g.lineWidth = 1; }
      g.fillStyle = muted; g.textAlign = 'center'; g.fillText(it.label, x + w / 2, q.h - 12);
    });
  }
  function lineChart(c, series, o) {
    const q = prep(c, 320), g = q.g, L = 56, R = 16, T = 12, B = 40, muted = cssv('--muted'), grid = cssv('--line-soft'), ink = cssv('--ink');
    let xs = [], my = 0; series.forEach(function (s) { s.points.forEach(function (p) { xs.push(p.x); my = Math.max(my, p.mean + p.ci); }); });
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), mx = niceMax(my * 1.04) || 1;
    const X = function (x) { return L + (x1 === x0 ? .5 : (x - x0) / (x1 - x0)) * (q.w - L - R); }, Y = function (y) { return T + (q.h - T - B) * (1 - y / mx); };
    g.fillStyle = muted; g.textAlign = 'right';
    for (let k = 0; k <= 5; k++) { const v = mx * k / 5, y = Y(v); g.strokeStyle = grid; g.beginPath(); g.moveTo(L, y); g.lineTo(q.w - R, y); g.stroke(); g.fillText(axisLabel(v, o.pct), L - 6, y + 4); }
    g.textAlign = 'center'; const uniq = xs.filter(function (v, i) { return xs.indexOf(v) === i; }), every = Math.ceil(uniq.length / Math.max(2, Math.floor((q.w - L) / 50)));
    uniq.forEach(function (v, i) { if (i % every === 0) g.fillText(fmt(v), X(v), q.h - B + 16); });
    g.fillText(o.xlabel, (L + q.w - R) / 2, q.h - 6);
    series.forEach(function (s) {
      g.strokeStyle = s.color; g.fillStyle = s.color; g.lineWidth = 2; g.beginPath();
      s.points.forEach(function (p, i) { i ? g.lineTo(X(p.x), Y(p.mean)) : g.moveTo(X(p.x), Y(p.mean)); }); g.stroke(); g.lineWidth = 1;
      s.points.forEach(function (p) {
        const x = X(p.x); if (p.ci > 0) { g.globalAlpha = .55; g.beginPath(); g.moveTo(x, Y(p.mean + p.ci)); g.lineTo(x, Y(Math.max(0, p.mean - p.ci))); g.stroke(); g.globalAlpha = 1; }
        g.beginPath(); g.arc(x, Y(p.mean), 3, 0, 6.3); g.fill();
      });
    });
  }

  /* ============================================================ COMPARE */
  function algoChips(el, sel) {
    $(el).innerHTML = ALGO_IDS.map(function (id) {
      return '<label class="chip"><input type="checkbox" value="' + id + '"' + (sel.indexOf(id) >= 0 ? ' checked' : '') + '><span class="sw" style="background:' + algoColor(id) + '"></span>' + SHORT[id] + '</label>';
    }).join('');
  }
  const checked = function (el) { return $$('input:checked', $(el)).map(function (i) { return i.value; }); };
  const CMP_CHARTS = ['avgTAT', 'avgWT', 'avgRT', 'throughput', 'cpuUtil', 'jain', 'ctxSwitches', 'p95WT', 'deadlineMisses'];

  async function runCompare() {
    const algos = checked('#cmpAlgos'); if (algos.length < 1) return toast('Choose at least one algorithm.', true);
    const wl = readWl(), cfg = readCfg(), runs = +$('#cmpRuns').value || 30, baseSeed = +$('#cmpSeed').value || 1;
    busy(true);
    try {
      const j = await api('/api/compare', { algorithms: algos, workload: wl, config: cfg, runs: runs, baseSeed: baseSeed }, function () { return S.compare(algos, wl, cfg, runs, baseSeed); });
      state.cmp = { data: j, algos: algos }; renderCompare();
    } catch (e) { toast(e.message, true); } finally { busy(false); }
  }
  function renderCompare() {
    const d = state.cmp.data, algos = state.cmp.algos; $('#cmpOut').hidden = false;
    $('#cmpCharts').innerHTML = CMP_CHARTS.map(function (k) {
      const m = S.METRICS.find(function (x) { return x.key === k; });
      return '<div class="chart-card"><h4>' + m.label + (m.lower ? ' <span class="muted small">lower is better</span>' : ' <span class="muted small">higher is better</span>') + '</h4><canvas id="cc_' + k + '"></canvas></div>';
    }).join('');
    state.redraw.cmp = function () {
      CMP_CHARTS.forEach(function (k) {
        const m = S.METRICS.find(function (x) { return x.key === k; }), c = $('#cc_' + k); if (!c) return;
        barChart(c, algos.map(function (a) { const r = d.results[a][k]; return { label: SHORT[a], mean: r.mean, ci: r.ci, color: algoColor(a) }; }), { pct: m.pct });
      });
    };
    state.redraw.cmp();
    // table
    const best = {};
    S.METRICS.forEach(function (m) {
      const vals = algos.map(function (a) { return d.results[a][m.key].mean; });
      if (algos.length < 2 || Math.max.apply(null, vals) - Math.min.apply(null, vals) < 1e-12) return;
      best[m.key] = algos[vals.indexOf(m.lower ? Math.min.apply(null, vals) : Math.max.apply(null, vals))];
    });
    $('#cmpTbl').innerHTML = '<thead><tr><th>Algorithm</th>' + S.METRICS.map(function (m) { return '<th>' + m.label + '</th>'; }).join('') + '</tr></thead><tbody>' +
      algos.map(function (a) {
        return '<tr><td><span class="chip" style="cursor:default"><span class="sw" style="background:' + algoColor(a) + '"></span>' + SHORT[a] + '</span></td>' + S.METRICS.map(function (m) {
          const r = d.results[a][m.key];
          return '<td class="' + (best[m.key] === a ? 'best' : '') + '">' + mfmt(m, r.mean) + ' <span class="muted small">±' + (m.pct ? (r.ci * 100).toFixed(1) + '%' : fmt(r.ci)) + '</span></td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
    // t-test controls
    const keep = { m: $('#ttMetric').value, a: $('#ttA').value, b: $('#ttB').value };
    $('#ttMetric').innerHTML = S.METRICS.map(function (m) { return '<option value="' + m.key + '">' + m.label + '</option>'; }).join('');
    const opts = algos.map(function (a) { return '<option value="' + a + '">' + SHORT[a] + '</option>'; }).join('');
    $('#ttA').innerHTML = opts; $('#ttB').innerHTML = opts;
    $('#ttMetric').value = keep.m || 'avgWT'; if (!$('#ttMetric').value) $('#ttMetric').value = 'avgWT';
    $('#ttA').value = algos.indexOf(keep.a) >= 0 ? keep.a : algos[0]; $('#ttB').value = algos.indexOf(keep.b) >= 0 ? keep.b : algos[Math.min(1, algos.length - 1)];
    runTTest();
  }
  function runTTest() {
    if (!state.cmp) return;
    const d = state.cmp.data, k = $('#ttMetric').value, a = $('#ttA').value, b = $('#ttB').value, m = S.METRICS.find(function (x) { return x.key === k; });
    if (a === b) { $('#ttOut').innerHTML = '<p class="muted">Choose two different algorithms.</p>'; return; }
    const r = S.pairedT(d.results[a][k].samples, d.results[b][k].samples), better = r.meanDiff === 0 ? null : ((r.meanDiff < 0) === m.lower ? a : b);
    const sig = r.p < 0.05;
    $('#ttOut').innerHTML = '<p><b>' + SHORT[a] + ' − ' + SHORT[b] + '</b> on ' + m.label.toLowerCase() + ': mean difference <b class="num">' + mfmt(m, r.meanDiff) + '</b> over ' + r.n + ' paired runs (t = <span class="num">' + fmt(r.t) + '</span>, df = ' + r.df + ', p = <span class="num">' + (r.p < 0.0001 ? '<0.0001' : r.p.toFixed(4)) + '</span>).</p>' +
      '<p style="color:' + (sig ? 'var(--ok)' : 'var(--warn)') + '">' + (sig ? (better ? SHORT[better] + ' is significantly better at the 5% level.' : 'No difference.') : 'Not significant at the 5% level — the gap could be random variation. Try more replications.') + '</p>';
  }

  /* ============================================================ SWEEP */
  const SWEEP = {
    quantum: { label: 'Time quantum (ticks)', from: 1, to: 12, step: 1 }, arrivalRate: { label: 'Arrival rate λ (load)', from: 0.01, to: 0.06, step: 0.005 },
    ioFraction: { label: 'I/O-bound share', from: 0, to: 1, step: 0.2 }, cpuBurstMean: { label: 'CPU-bound burst mean', from: 5, to: 40, step: 5 },
    n: { label: 'Number of processes', from: 10, to: 100, step: 10 }, csCost: { label: 'Context-switch cost (ticks)', from: 0, to: 4, step: 1 }
  };
  function setSweepDefaults() { const s = SWEEP[$('#swParam').value]; $('#swFrom').value = s.from; $('#swTo').value = s.to; $('#swStep').value = s.step; }
  async function runSweep() {
    const algos = checked('#swAlgos'); if (!algos.length) return toast('Choose at least one algorithm.', true);
    const from = +$('#swFrom').value, to = +$('#swTo').value, step = +$('#swStep').value;
    if (!(step > 0) || to < from) return toast('Check from / to / step.', true);
    const values = []; for (let v = from; v <= to + 1e-9 && values.length < 40; v += step) values.push(+v.toFixed(6));
    const param = $('#swParam').value, metric = $('#swMetric').value, runs = +$('#swRuns').value || 10, wl = readWl(), cfg = readCfg();
    busy(true);
    try {
      const j = await api('/api/sweep', { algorithms: algos, workload: wl, config: cfg, param: param, values: values, runs: runs, baseSeed: 1, metric: metric }, function () { return S.sweep(algos, wl, cfg, param, values, runs, 1, metric); });
      state.sweep = { data: j, param: param, metric: metric }; renderSweep();
    } catch (e) { toast(e.message, true); } finally { busy(false); }
  }
  function renderSweep() {
    const sw = state.sweep, m = S.METRICS.find(function (x) { return x.key === sw.metric; }); $('#swOut').hidden = false;
    $('#swTitle').textContent = m.label + ' vs ' + SWEEP[sw.param].label.toLowerCase();
    const series = sw.data.series.map(function (s) { return { name: SHORT[s.algo], algo: s.algo, color: algoColor(s.algo), points: s.points }; });
    $('#swLegend').innerHTML = series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + s.name + '</span>'; }).join('') + '<span>whiskers = 95% CI</span>';
    state.redraw.sweep = function () { lineChart($('#swCanvas'), series, { pct: m.pct, xlabel: SWEEP[sw.param].label }); }; state.redraw.sweep();
    $('#swTbl').innerHTML = '<thead><tr><th>' + SWEEP[sw.param].label + '</th>' + series.map(function (s) { return '<th>' + s.name + '</th>'; }).join('') + '</tr></thead><tbody>' +
      series[0].points.map(function (p, i) { return '<tr><td>' + fmt(p.x) + '</td>' + series.map(function (s) { const q = s.points[i]; return '<td>' + mfmt(m, q.mean) + ' <span class="muted small">±' + (m.pct ? (q.ci * 100).toFixed(1) + '%' : fmt(q.ci)) + '</span></td>'; }).join('') + '</tr>'; }).join('') + '</tbody>';
  }

  /* ============================================================ LEARN */
  const INFO = [
    { id: 'FCFS', name: 'First-Come, First-Served', pre: false, starve: 'none', big: 'O(1)', use: 'Batch queues, simple systems', short: 'Runs processes in arrival order to completion. Simple, but long jobs make short ones wait (convoy effect).',
      code: 'ready = FIFO queue\non arrival: enqueue(P)\nwhile ready not empty:\n  P = dequeue(ready)\n  run P to completion' },
    { id: 'SJF', name: 'Shortest Job First', pre: false, starve: 'high', big: 'O(log n) with heap', use: 'Batch work with known burst lengths', short: 'Picks the process with the shortest next CPU burst. Minimises average waiting time, but long jobs can starve.',
      code: 'ready = min-heap keyed by burst length\nwhile ready not empty:\n  P = extract_min(ready)\n  run P to completion' },
    { id: 'SRTF', name: 'Shortest Remaining Time First', pre: true, starve: 'high', big: 'O(log n)', use: 'Short interactive jobs mixed with batch', short: 'Preemptive SJF: a new arrival with less remaining time takes the CPU. Best average turnaround, many switches.',
      code: 'ready = min-heap keyed by remaining time\non arrival of Q:\n  if Q.remaining < current.remaining:\n    preempt current; run Q' },
    { id: 'RR', name: 'Round Robin', pre: true, starve: 'none', big: 'O(1)', use: 'Time-sharing, interactive systems', short: 'Each process gets one quantum, then goes to the back of the queue. Quantum ≈ ∞ behaves like FCFS; tiny quantum means heavy switching.',
      code: 'ready = FIFO queue\nwhile ready not empty:\n  P = dequeue(ready)\n  run P for min(quantum, P.remaining)\n  if P.remaining > 0: enqueue(P)' },
    { id: 'PRIO_NP', name: 'Priority (non-preemptive)', pre: false, starve: 'high', big: 'O(log n)', use: 'Systems with clearly more important work', short: 'Runs the highest-priority ready process to completion; ties are FCFS. Enable aging to fight starvation.',
      code: 'ready = priority queue\nwhile ready not empty:\n  P = extract_highest_priority(ready)\n  run P to completion' },
    { id: 'PRIO_P', name: 'Priority (preemptive)', pre: true, starve: 'high', big: 'O(log n)', use: 'Interactive and real-time systems', short: 'A higher-priority arrival preempts the running process at once. Aging gradually raises the priority of waiting jobs.',
      code: 'on arrival of Q:\n  if Q.priority better than current.priority:\n    preempt current; insert it back; run Q\naging: every N ticks waiting, priority -= 1' },
    { id: 'MLQ', name: 'Multilevel Queue', pre: true, starve: 'medium', big: 'O(#queues)', use: 'Distinct process classes (system / interactive / batch)', short: 'Processes are statically assigned to queues; higher queues are always served first. Here: Q0 RR(q), Q1 RR(2q), Q2 FCFS, chosen by priority.',
      code: 'for queue in [Q0, Q1, Q2]:\n  if queue not empty:\n    run per that queue\'s policy\n    break  // strict priority between queues' },
    { id: 'MLFQ', name: 'Multilevel Feedback Queue', pre: true, starve: 'low', big: 'O(1) per level', use: 'General-purpose multitasking (Unix-style)', short: 'New jobs start at the top. Using a full quantum demotes a job; blocking for I/O keeps its level. Periodic boost prevents starvation.',
      code: 'new process → top queue\nrun highest non-empty queue (RR inside)\nif P used its whole quantum: demote(P)\nif P blocks for I/O early: keep level\nevery BOOST ticks: move all to top' },
    { id: 'EDF', name: 'Earliest Deadline First', pre: true, starve: 'deadline misses', big: 'O(log n)', use: 'Real-time tasks with deadlines', short: 'Always runs the process whose absolute deadline is nearest. Optimal on one CPU while total utilisation ≤ 100%.',
      code: 'ready = min-heap keyed by deadline\non arrival of Q:\n  if Q.deadline < current.deadline: preempt' },
    { id: 'LOTTERY', name: 'Lottery', pre: true, starve: 'none (probabilistic)', big: 'O(1) – O(n)', use: 'Proportional-share, virtualisation', short: 'Every quantum a random ticket is drawn; CPU share converges to each process\'s ticket share. Tickets here come from priority.',
      code: 'every quantum:\n  total = sum(tickets of ready)\n  winner = ticket drawn uniformly in [0, total)\n  run winner for one quantum' },
    { id: 'FAIR', name: 'Fair-Share', pre: true, starve: 'none', big: 'O(n)', use: 'Multi-user systems and accounting', short: 'Shares CPU between users, not processes: the ready process of the user who has used the least CPU runs next.',
      code: 'every quantum:\n  U = user with least CPU used (having ready work)\n  run next ready process of U for one quantum' }
  ];
  const CONVENTIONS = [
    'One tick is one unit of time on a single CPU. Processes alternate CPU and I/O bursts; I/O devices never queue.',
    'Lower priority number means more important (0 is the highest).',
    'When a quantum expires at the same moment a process arrives (or returns from I/O), the newcomer joins the queue first. This is the usual textbook convention.',
    'A context switch is counted whenever a different process is dispatched than the one that ran last (the very first dispatch is free). Each costs the “context-switch cost” in idle ticks.',
    'Waiting time is time spent in the ready queue. Without I/O this equals turnaround − burst; with I/O, turnaround = CPU + I/O + waiting.',
    'Jain’s fairness index is computed over each process’s share = CPU time ÷ turnaround time (1.0 = perfectly even).',
    'MLFQ quanta double at each level (q, 2q, 4q…). EDF uses the absolute deadline column; processes without one run last.'
  ];
  const METRIC_DEFS = [
    ['Throughput', 'processes completed ÷ makespan'], ['Turnaround (TAT)', 'completion − arrival'], ['Waiting (WT)', 'ticks spent in the ready queue'],
    ['Response (RT)', 'first time on CPU − arrival'], ['CPU utilization', 'busy ticks ÷ makespan'], ['Fairness', 'Jain index of CPU share ÷ turnaround'],
    ['Starvation', 'max wait, 95th-percentile wait, and number of processes waiting longer than a threshold (100 ticks)'], ['Context switches', 'dispatches of a different process than the last one run'],
    ['Deadline misses', 'processes finishing after their absolute deadline']
  ];
  function renderLearn() {
    $('#conventions').innerHTML = '<ul style="margin:0;padding-left:20px">' + CONVENTIONS.map(function (c) { return '<li>' + c + '</li>'; }).join('') + '</ul>';
    $('#algoGrid').innerHTML = INFO.map(function (a) {
      return '<article class="card algo"><h3>' + a.name + '<span><span class="tag ' + (a.pre ? 'ok' : '') + '">' + (a.pre ? 'preemptive' : 'non-preemptive') + '</span> <span class="tag ' + (a.starve === 'none' || a.starve.indexOf('none') === 0 ? 'ok' : 'warn') + '">starvation: ' + a.starve + '</span></span></h3><p>' + a.short + '</p><pre>' + esc(a.code) + '</pre><p class="small muted">Cost per decision: ' + a.big + '. Typical use: ' + a.use + '.</p><button class="btn sm" data-try="' + a.id + '">Try it on the current processes</button></article>';
    }).join('');
    $('#metricTbl').innerHTML = '<tbody>' + METRIC_DEFS.map(function (r) { return '<tr><td class="l"><b>' + r[0] + '</b></td><td class="l">' + r[1] + '</td></tr>'; }).join('') + '</tbody>';
    $('#summaryTbl').innerHTML = '<thead><tr><th>Algorithm</th><th class="l">Preemptive</th><th class="l">Starvation risk</th><th class="l">Cost / decision</th><th class="l">Best for</th></tr></thead><tbody>' +
      INFO.map(function (a) { return '<tr><td>' + a.name + '</td><td class="l">' + (a.pre ? 'Yes' : 'No') + '</td><td class="l">' + a.starve + '</td><td class="l">' + a.big + '</td><td class="l">' + a.use + '</td></tr>'; }).join('') + '</tbody>';
    $('#algoGrid').onclick = function (e) {
      const b = e.target.closest('[data-try]'); if (!b) return; $('#algo').value = b.dataset.try; updateVisibility(); showTab('sim'); runSim();
    };
  }
  function showTests(list, where) {
    const pass = list.filter(function (t) { return t.pass; }).length;
    $('#testOut').innerHTML = '<p><b style="color:' + (pass === list.length ? 'var(--ok)' : 'var(--bad)') + '">' + pass + ' / ' + list.length + ' passed</b> <span class="muted">(ran ' + where + ')</span></p>' +
      list.map(function (t) { return '<div class="test ' + (t.pass ? 'pass' : 'fail') + '"><b>' + (t.pass ? '✓' : '✗') + '</b><span>' + esc(t.name) + (t.detail ? ' <span class="muted small">' + esc(t.detail) + '</span>' : '') + '</span></div>'; }).join('');
  }

  /* ============================================================ SAVED RUNS */
  async function loadRuns() {
    const out = $('#runsOut');
    if (!state.serverUp) { out.innerHTML = '<div class="empty">Saved runs live on the server. Start it with <code>node server.js</code> and open this page from <code>http://localhost:3000</code>.</div>'; return; }
    try {
      const j = await (await fetch('/api/runs')).json();
      if (!j.runs.length) { out.innerHTML = '<div class="empty">Nothing saved yet. Run a simulation and press <b>Save run</b>.</div>'; return; }
      out.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th class="l">Name</th><th class="l">Algorithm</th><th>Processes</th><th>Avg TAT</th><th>Avg WT</th><th class="l">Saved</th><th></th></tr></thead><tbody>' +
        j.runs.map(function (r) { return '<tr><td class="l">' + esc(r.name) + '</td><td class="l">' + (SHORT[r.algorithm] || r.algorithm) + '</td><td>' + r.n + '</td><td>' + fmt(r.metrics.avgTAT) + '</td><td>' + fmt(r.metrics.avgWT) + '</td><td class="l">' + new Date(r.savedAt).toLocaleString() + '</td><td><button class="btn sm" data-load="' + r.id + '">Load</button> <button class="btn sm ghost" data-rm="' + r.id + '">Delete</button></td></tr>'; }).join('') + '</tbody></table></div>';
    } catch (e) { out.innerHTML = '<div class="empty">Could not reach the server.</div>'; }
  }
  async function runsClick(e) {
    const l = e.target.closest('[data-load]'), d = e.target.closest('[data-rm]');
    try {
      if (l) {
        const r = await (await fetch('/api/runs/' + l.dataset.load)).json();
        state.procs = r.processes; $('#algo').value = r.algorithm;
        ['quantum', 'csCost', 'aging', 'levels', 'boost', 'seed'].forEach(function (k) { if (r.config[k] !== undefined) $('#' + k).value = r.config[k]; });
        updateVisibility(); renderProcs(); showTab('sim'); runSim();
      } else if (d) { await fetch('/api/runs/' + d.dataset.rm, { method: 'DELETE' }); loadRuns(); }
    } catch (err) { toast(err.message, true); }
  }

  /* ============================================================ TABS & INIT */
  function showTab(t) {
    $$('#tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === t); });
    ['sim', 'compare', 'sweep', 'learn', 'runs'].forEach(function (x) { $('#tab-' + x).hidden = x !== t; });
    if (t === 'runs') loadRuns();
    if (t === 'compare' && state.redraw.cmp) state.redraw.cmp();
    if (t === 'sweep' && state.redraw.sweep) state.redraw.sweep();
  }

  function init() {
    $('#algo').innerHTML = ALGO_IDS.map(function (id) { return '<option value="' + id + '">' + S.ALGOS[id].label + '</option>'; }).join('');
    $('#algo').value = 'RR';
    $('#example').innerHTML = '<option value="">Random workload (use Generate)</option>' + Object.keys(EXAMPLES).map(function (k) { return '<option value="' + k + '">' + EXAMPLES[k].label + '</option>'; }).join('');
    algoChips('#cmpAlgos', ['FCFS', 'SJF', 'SRTF', 'RR', 'PRIO_P', 'MLFQ']); algoChips('#swAlgos', ['FCFS', 'SRTF', 'RR', 'MLFQ']);
    $('#swParam').innerHTML = Object.keys(SWEEP).map(function (k) { return '<option value="' + k + '">' + SWEEP[k].label + '</option>'; }).join('');
    $('#swMetric').innerHTML = S.METRICS.map(function (m) { return '<option value="' + m.key + '">' + m.label + '</option>'; }).join(''); $('#swMetric').value = 'avgWT';
    setSweepDefaults(); renderLearn(); bindProcEditor();

    $$('#tabs button').forEach(function (b) { b.onclick = function () { showTab(b.dataset.tab); }; });
    $('#modeClient').onclick = function () { state.mode = 'client'; updateEngineUI(); };
    $('#modeServer').onclick = function () { if (state.serverUp) { state.mode = 'server'; updateEngineUI(); } };
    $('#algo').onchange = updateVisibility;
    $('#example').onchange = function () { loadExample($('#example').value); };
    $$('[id^=w_]').forEach(function (el) { el.addEventListener('input', updateLoadHint); });
    $('#btnGen').onclick = generate; $('#btnRun').onclick = runSim; $('#btnCmp').onclick = runCompare; $('#btnSweep').onclick = runSweep;
    $('#btnSave').onclick = saveRun; $('#btnCsv').onclick = exportCsv; $('#btnPlay').onclick = togglePlay;
    $('#swParam').onchange = setSweepDefaults;
    $('#zoom').oninput = drawGantt; $('#scrub').oninput = function () { stopPlay(); setScrub(+$('#scrub').value); };
    ['ttMetric', 'ttA', 'ttB'].forEach(function (id) { $('#' + id).onchange = runTTest; });
    $('#btnRefreshRuns').onclick = loadRuns; $('#runsOut').onclick = runsClick;
    $('#btnTestClient').onclick = function () { showTests(S.selfTests(), 'in your browser'); };
    $('#btnTestServer').onclick = async function () { try { const j = await (await fetch('/api/selftest')).json(); showTests(j.tests, 'on the server'); } catch (e) { toast('Server unreachable.', true); } };
    let rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if ($('#tab-compare').hidden === false && state.redraw.cmp) state.redraw.cmp(); if ($('#tab-sweep').hidden === false && state.redraw.sweep) state.redraw.sweep(); }, 150); });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { drawGantt(); Object.keys(state.redraw).forEach(function (k) { state.redraw[k](); }); });

    updateLoadHint(); loadExample('doc'); $('#example').value = 'doc'; updateEngineUI(); probeServer();
  }
  init();
})();
