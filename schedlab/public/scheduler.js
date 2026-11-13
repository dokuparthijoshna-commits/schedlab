/* SchedLab engine — one file, used by BOTH the browser (client side) and Node (server side).
 * Discrete-time (1 tick = 1 time unit) simulation of a single CPU.
 * Process = alternating bursts [cpu, io, cpu, io, ..., cpu].
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sched = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- RNG */
  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ----------------------------------------------------------- Defaults */
  const DEFAULT_CFG = {
    quantum: 3, csCost: 0, aging: 0, levels: 3, boost: 0,
    mlqCut: [1, 3], seed: 1, maxTime: 2000000, starveThreshold: 100
  };
  const DEFAULT_WL = {
    n: 20, seed: 1, arrivalMode: 'poisson', arrivalRate: 0.04, burstDist: 'exp',
    ioFraction: 0.4, cpuBurstMean: 18, ioBurstMean: 3, ioTimeMean: 8,
    priorityLevels: 5, users: 3, deadlineSlack: 4
  };

  /* ---------------------------------------------- Process normalization */
  function parseBursts(b) {
    if (Array.isArray(b)) return b.map(Number);
    return String(b == null ? '' : b).split(/[\s,;]+/).filter(Boolean).map(Number);
  }

  function normalize(list) {
    const seen = {};
    return (list || []).map(function (p, i) {
      let bursts = parseBursts(p.bursts != null ? p.bursts : p.burst)
        .map(function (x) { return isFinite(x) ? Math.max(0, Math.round(x)) : 1; });
      if (!bursts.length) bursts = [1];
      if (bursts.length % 2 === 0) bursts.pop();          // must end on a CPU burst
      if (bursts.length > 1) bursts = bursts.map(function (x) { return Math.max(1, x); });
      let cpu = 0, io = 0;
      bursts.forEach(function (x, k) { if (k % 2 === 0) cpu += x; else io += x; });
      let pid = String(p.pid || ('P' + (i + 1)));
      if (seen[pid]) pid = pid + '_' + (i + 1);
      seen[pid] = true;
      const dl = (p.deadline === null || p.deadline === undefined || p.deadline === '' || !isFinite(+p.deadline)) ? null : +p.deadline;
      return {
        pid: pid, arrival: Math.max(0, Math.round(+p.arrival || 0)), bursts: bursts,
        priority: Number.isFinite(+p.priority) ? Math.round(+p.priority) : 0,
        deadline: dl, tickets: Math.max(1, Math.round(+p.tickets || 10)),
        user: (p.user !== undefined && p.user !== null && p.user !== '') ? String(p.user) : 'U1',
        cpuTotal: cpu, ioTotal: io
      };
    });
  }

  /* --------------------------------------------------------- Algorithms */
  function cmp(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  }
  function byKey(fn) {
    return function (ready, ctx) {
      let bi = 0, bk = fn(ready[0], ctx);
      for (let i = 1; i < ready.length; i++) {
        const k = fn(ready[i], ctx);
        if (cmp(k, bk) < 0) { bi = i; bk = k; }
      }
      return bi;
    };
  }
  function preemptOnBetter(fn) {   // preempt only if some ready process is strictly better on the primary key
    return function (cur, ready, ctx) {
      if (!ready.length) return false;
      let m = Infinity;
      for (let i = 0; i < ready.length; i++) m = Math.min(m, fn(ready[i], ctx)[0]);
      return m < fn(cur, ctx)[0];
    };
  }
  const INF = Infinity;
  const mlqLevel = function (p, c) { return p.priority <= c.mlqCut[0] ? 0 : (p.priority <= c.mlqCut[1] ? 1 : 2); };

  const ALGOS = {};
  function def(id, o) { ALGOS[id] = Object.assign({ id: id, preemptive: false, quantum: function () { return INF; } }, o); }

  const kSeq = function (p) { return [p.seq]; };
  const kRem = function (p) { return [p.rem, p.seq]; };
  const kPri = function (p) { return [p.effPrio, p.seq]; };
  const kLvl = function (p) { return [p.level, p.seq]; };
  const kDl = function (p) { return [p.deadline == null ? INF : p.deadline, p.seq]; };
  const kFair = function (p, x) { return [x.userUsage[p.user] || 0, p.seq]; };

  def('FCFS', { label: 'First-Come First-Served', pick: byKey(kSeq) });
  def('SJF', { label: 'Shortest Job First (non-preemptive)', pick: byKey(kRem) });
  def('SRTF', { label: 'Shortest Remaining Time First', preemptive: true, pick: byKey(kRem), shouldPreempt: preemptOnBetter(kRem) });
  def('RR', { label: 'Round Robin', preemptive: true, pick: byKey(kSeq), quantum: function (p, c) { return c.quantum; } });
  def('PRIO_NP', { label: 'Priority (non-preemptive)', pick: byKey(kPri) });
  def('PRIO_P', { label: 'Priority (preemptive)', preemptive: true, pick: byKey(kPri), shouldPreempt: preemptOnBetter(kPri) });
  def('MLQ', {
    label: 'Multilevel Queue', preemptive: true,
    init: function (p, c) { p.level = mlqLevel(p, c); },
    pick: byKey(kLvl), shouldPreempt: preemptOnBetter(kLvl),
    quantum: function (p, c) { return p.level === 0 ? c.quantum : (p.level === 1 ? c.quantum * 2 : INF); }
  });
  def('MLFQ', {
    label: 'Multilevel Feedback Queue', preemptive: true, boost: true,
    init: function (p) { p.level = 0; },
    pick: byKey(kLvl), shouldPreempt: preemptOnBetter(kLvl),
    quantum: function (p, c) { return c.quantum * Math.pow(2, Math.min(p.level, 20)); },
    onExpire: function (p, c) { p.level = Math.min(c.levels - 1, p.level + 1); }
  });
  def('EDF', { label: 'Earliest Deadline First', preemptive: true, pick: byKey(kDl), shouldPreempt: preemptOnBetter(kDl) });
  def('LOTTERY', {
    label: 'Lottery', preemptive: true,
    pick: function (ready, ctx) {
      let total = 0; ready.forEach(function (p) { total += p.tickets; });
      let r = ctx.rng() * total;
      for (let i = 0; i < ready.length; i++) { r -= ready[i].tickets; if (r < 0) return i; }
      return ready.length - 1;
    },
    quantum: function (p, c) { return c.quantum; }
  });
  def('FAIR', { label: 'Fair-Share (per user)', preemptive: true, pick: byKey(kFair), quantum: function (p, c) { return c.quantum; } });

  /* ------------------------------------------------------------ Metrics */
  const METRICS = [
    { key: 'avgTAT', label: 'Avg turnaround', lower: true },
    { key: 'avgWT', label: 'Avg waiting', lower: true },
    { key: 'avgRT', label: 'Avg response', lower: true },
    { key: 'throughput', label: 'Throughput (proc/tick)', lower: false },
    { key: 'cpuUtil', label: 'CPU utilization', lower: false, pct: true },
    { key: 'jain', label: 'Fairness (Jain index)', lower: false },
    { key: 'ctxSwitches', label: 'Context switches', lower: true },
    { key: 'maxWT', label: 'Max wait', lower: true },
    { key: 'p95WT', label: '95th pct wait', lower: true },
    { key: 'starved', label: 'Starved processes', lower: true },
    { key: 'deadlineMisses', label: 'Deadline misses', lower: true },
    { key: 'makespan', label: 'Makespan', lower: true }
  ];

  function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  function std(a) {
    if (a.length < 2) return 0; const m = mean(a); let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }
  const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  function tcrit(df) { if (df < 1) return 0; if (df <= 30) return T95[df - 1]; if (df <= 60) return 2.0; if (df <= 120) return 1.98; return 1.96; }
  function ci95(a) { return a.length < 2 ? 0 : tcrit(a.length - 1) * std(a) / Math.sqrt(a.length); }
  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  }

  // Student-t two-sided p-value through the regularised incomplete beta function
  function lgamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp); let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function betacf(a, b, x) {
    const FP = 1e-300; let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FP) d = FP; d = 1 / d; let h = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d;
      const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break;
    }
    return h;
  }
  function incbeta(a, b, x) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  function pairedT(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return { n: n, meanDiff: 0, t: 0, df: 0, p: 1 };
    const d = []; for (let i = 0; i < n; i++) d.push(a[i] - b[i]);
    const md = mean(d), sd = std(d);
    if (sd === 0) return { n: n, meanDiff: md, t: md === 0 ? 0 : Infinity, df: n - 1, p: md === 0 ? 1 : 0 };
    const t = md / (sd / Math.sqrt(n)), df = n - 1;
    return { n: n, meanDiff: md, t: t, df: df, p: incbeta(df / 2, 0.5, df / (df + t * t)) };
  }

  /* ----------------------------------------------------------- Simulate */
  function simulate(algo, input, cfgIn, opts) {
    const cfg = Object.assign({}, DEFAULT_CFG, cfgIn || {});
    cfg.quantum = Math.max(1, Math.round(+cfg.quantum || 1));
    cfg.csCost = Math.max(0, Math.round(+cfg.csCost || 0));
    cfg.levels = Math.max(1, Math.round(+cfg.levels || 3));
    opts = opts || {};
    const A = ALGOS[algo];
    if (!A) throw new Error('Unknown algorithm: ' + algo);
    const procs = normalize(input);
    const N = procs.length;
    if (!N) throw new Error('Add at least one process.');
    const trace = !!opts.trace;
    const rng = mulberry32(cfg.seed);

    const P = procs.map(function (p, i) {
      return Object.assign({}, p, {
        idx: i, burstIdx: 0, rem: p.bursts[0], level: 0, effPrio: p.priority, seq: 0, ioDone: 0,
        firstStart: -1, completion: -1, wait: 0, ageWait: 0, state: 'new'
      });
    });
    const byArr = P.slice().sort(function (a, b) { return a.arrival - b.arrival || a.idx - b.idx; });

    let t = 0, seq = 0, ai = 0, qLeft = 0, csLeft = 0, switches = 0, busy = 0, csTicks = 0, idleTicks = 0, done = 0;
    let current = null, last = null, pending = null, lastSig = '';
    const ready = [], waiting = [], gantt = [], qlog = [], events = [];
    const userUsage = {};
    const ctx = { cfg: cfg, rng: rng, userUsage: userUsage, t: 0 };

    function addSeg(kind, pid, s, e) {
      if (!trace) return;
      const g = gantt[gantt.length - 1];
      if (g && g.kind === kind && g.pid === pid && g.end === s) g.end = e;
      else gantt.push({ kind: kind, pid: pid, start: s, end: e });
    }
    function ev(type, p) { if (trace && events.length < 6000) events.push({ t: t, type: type, pid: p ? p.pid : null }); }
    function logQ() {
      if (!trace || qlog.length >= 20000) return;
      const r = ready.map(function (p) { return p.pid; }), w = waiting.map(function (p) { return p.pid; });
      const sig = (current ? current.pid : '-') + '|' + r.join(',') + '|' + w.join(',');
      if (sig !== lastSig) { lastSig = sig; qlog.push({ t: t, run: current ? current.pid : null, ready: r, io: w }); }
    }

    while (done < N) {
      if (t > cfg.maxTime) throw new Error('Simulation exceeded maxTime (' + cfg.maxTime + ' ticks).');
      ctx.t = t;

      // 1. arrivals
      while (ai < N && byArr[ai].arrival <= t) {
        const p = byArr[ai++];
        if (p.rem === 0) { p.firstStart = t; p.completion = t; p.state = 'done'; done++; ev('finish', p); continue; }
        p.state = 'ready'; p.seq = seq++;
        if (A.init) A.init(p, cfg);
        ready.push(p); ev('arrive', p);
      }
      // 2. I/O completions
      if (waiting.length) {
        const back = waiting.filter(function (p) { return p.ioDone <= t; })
          .sort(function (a, b) { return a.ioDone - b.ioDone || a.idx - b.idx; });
        back.forEach(function (p) {
          waiting.splice(waiting.indexOf(p), 1);
          p.state = 'ready'; p.seq = seq++; ready.push(p); ev('io-done', p);
        });
      }
      // 3. process that just used up its quantum goes behind new arrivals
      if (pending) { pending.state = 'ready'; pending.seq = seq++; ready.push(pending); pending = null; }
      if (done >= N) break;

      // 4. preemption + dispatch
      if (csLeft === 0) {
        if (current && A.shouldPreempt && A.shouldPreempt(current, ready, ctx)) {
          ev('preempt', current); current.state = 'ready'; current.seq = seq++; ready.push(current); current = null;
        }
        if (!current && ready.length) {
          const i = A.pick(ready, ctx);
          current = ready.splice(i, 1)[0]; current.state = 'running';
          qLeft = A.quantum(current, cfg);
          if (cfg.aging > 0) current.effPrio = current.priority;
          if (last && last !== current) { switches++; csLeft = cfg.csCost; ev('switch', current); }
          else ev('dispatch', current);
        }
      }
      logQ();

      // 5a. context-switch overhead tick
      if (csLeft > 0) {
        csLeft--; csTicks++; addSeg('cs', null, t, t + 1);
        ready.forEach(function (p) { p.wait++; p.ageWait++; });
        t++; continue;
      }
      // 5b. idle: jump to next event
      if (!current) {
        let nxt = ai < N ? byArr[ai].arrival : INF;
        waiting.forEach(function (p) { nxt = Math.min(nxt, p.ioDone); });
        if (nxt === INF || nxt <= t) nxt = t + 1;
        addSeg('idle', null, t, nxt); idleTicks += nxt - t; t = nxt; continue;
      }
      // 5c. run one tick
      if (current.firstStart < 0) current.firstStart = t;
      addSeg('run', current.pid, t, t + 1);
      busy++; current.rem--; qLeft--; last = current;
      userUsage[current.user] = (userUsage[current.user] || 0) + 1;
      ready.forEach(function (p) { p.wait++; p.ageWait++; });
      t++;

      if (current.rem === 0) {
        const c = current; current = null; const bi = c.burstIdx;
        if (bi + 1 >= c.bursts.length) { c.completion = t; c.state = 'done'; done++; ev('finish', c); }
        else {
          c.ioDone = t + c.bursts[bi + 1]; c.burstIdx = bi + 2; c.rem = c.bursts[bi + 2];
          c.state = 'waiting'; waiting.push(c); if (A.onBlock) A.onBlock(c, cfg); ev('block', c);
        }
      } else if (qLeft <= 0) {
        if (A.onExpire) A.onExpire(current, cfg);
        ev('quantum', current); pending = current; current = null;
      }
      if (cfg.aging > 0) ready.forEach(function (p) { if (p.ageWait >= cfg.aging) { if (p.effPrio > 0) p.effPrio--; p.ageWait = 0; } });
      if (A.boost && cfg.boost > 0 && t % cfg.boost === 0) {
        ready.forEach(function (p) { p.level = 0; });
        if (current) current.level = 0; if (pending) pending.level = 0;
      }
    }

    // ---- metrics
    let makespan = 0;
    P.forEach(function (p) { makespan = Math.max(makespan, p.completion); });
    const out = P.map(function (p) {
      const tat = p.completion - p.arrival;
      return {
        pid: p.pid, arrival: p.arrival, cpu: p.cpuTotal, io: p.ioTotal, priority: p.priority, user: p.user,
        deadline: p.deadline, firstStart: p.firstStart, completion: p.completion, tat: tat, wait: p.wait,
        response: p.firstStart - p.arrival, share: tat > 0 ? p.cpuTotal / tat : 1,
        missed: p.deadline != null && p.completion > p.deadline
      };
    });
    const tats = out.map(function (o) { return o.tat; }), wts = out.map(function (o) { return o.wait; });
    const sw = wts.slice().sort(function (a, b) { return a - b; });
    let s1 = 0, s2 = 0; out.forEach(function (o) { s1 += o.share; s2 += o.share * o.share; });
    const metrics = {
      avgTAT: mean(tats), avgWT: mean(wts), avgRT: mean(out.map(function (o) { return o.response; })),
      stdTAT: std(tats), stdWT: std(wts),
      throughput: makespan > 0 ? N / makespan : 0,
      cpuUtil: makespan > 0 ? busy / makespan : 0,
      jain: s2 > 0 ? (s1 * s1) / (N * s2) : 1,
      ctxSwitches: switches, maxWT: sw[sw.length - 1], p95WT: percentile(sw, 0.95),
      starved: out.filter(function (o) { return o.wait > cfg.starveThreshold; }).length,
      deadlineMisses: out.filter(function (o) { return o.missed; }).length,
      makespan: makespan, busyTicks: busy, idleTicks: idleTicks, csTicks: csTicks, n: N
    };
    const res = { algorithm: algo, label: A.label, config: cfg, processes: out, metrics: metrics };
    if (trace) { res.gantt = gantt; res.qlog = qlog; res.events = events; }
    return res;
  }

  /* ------------------------------------------------- Workload generator */
  function estimateLoad(wp) {
    const w = Object.assign({}, DEFAULT_WL, wp || {});
    const cpu = w.ioFraction * 5 * w.ioBurstMean + (1 - w.ioFraction) * 1.5 * w.cpuBurstMean;
    return w.arrivalMode === 'batch' ? null : w.arrivalRate * cpu;
  }
  function generateWorkload(wp) {
    const w = Object.assign({}, DEFAULT_WL, wp || {});
    const rng = mulberry32(Math.round(w.seed) * 7919 + 13);
    const n = Math.max(1, Math.min(5000, Math.round(w.n)));
    function sample(mean_) {
      let v;
      if (w.burstDist === 'uniform') v = rng() * 2 * mean_;
      else if (w.burstDist === 'normal') v = mean_ + 0.35 * mean_ * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
      else v = -mean_ * Math.log(1 - rng());
      return Math.max(1, Math.round(v));
    }
    const list = []; let at = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        if (w.arrivalMode === 'poisson') at += Math.round(-Math.log(1 - rng()) / Math.max(1e-6, w.arrivalRate));
        else if (w.arrivalMode === 'fixed') at += Math.round(1 / Math.max(1e-6, w.arrivalRate));
      }
      const ioBound = rng() < w.ioFraction;
      const nb = ioBound ? 3 + Math.floor(rng() * 5) : 1 + Math.floor(rng() * 2);
      const m = ioBound ? w.ioBurstMean : w.cpuBurstMean;
      const bursts = []; let total = 0;
      for (let k = 0; k < nb; k++) {
        const c = sample(m); bursts.push(c); total += c;
        if (k < nb - 1) { const io = sample(w.ioTimeMean); bursts.push(io); total += io; }
      }
      const pr = Math.floor(rng() * w.priorityLevels);
      list.push({
        pid: 'P' + (i + 1), arrival: at, bursts: bursts, priority: pr,
        deadline: at + Math.ceil(w.deadlineSlack * total), tickets: (w.priorityLevels - pr) * 10,
        user: 'U' + (1 + Math.floor(rng() * w.users)), type: ioBound ? 'io' : 'cpu'
      });
    }
    return normalize(list);
  }

  /* ----------------------------------------------------- Experiments */
  function summarize(samples) { return { mean: mean(samples), std: std(samples), ci: ci95(samples), n: samples.length, samples: samples }; }

  function compare(algos, wp, cfg, runs, baseSeed) {
    runs = Math.max(1, Math.min(200, Math.round(runs || 30)));
    baseSeed = Math.round(baseSeed || 1);
    const acc = {};
    algos.forEach(function (a) { acc[a] = {}; METRICS.forEach(function (m) { acc[a][m.key] = []; }); });
    for (let r = 0; r < runs; r++) {
      const procs = generateWorkload(Object.assign({}, wp, { seed: baseSeed + r }));
      algos.forEach(function (a) {
        const res = simulate(a, procs, Object.assign({}, cfg, { seed: baseSeed + r }));
        METRICS.forEach(function (m) { acc[a][m.key].push(res.metrics[m.key]); });
      });
    }
    const results = {};
    algos.forEach(function (a) {
      results[a] = {}; METRICS.forEach(function (m) { results[a][m.key] = summarize(acc[a][m.key]); });
    });
    return { runs: runs, baseSeed: baseSeed, results: results };
  }

  const CFG_PARAMS = ['quantum', 'csCost', 'aging', 'levels', 'boost'];
  function sweep(algos, wp, cfg, param, values, runs, baseSeed, metric) {
    const series = algos.map(function (a) { return { algo: a, points: [] }; });
    values.forEach(function (v) {
      const w2 = Object.assign({}, wp), c2 = Object.assign({}, cfg);
      if (CFG_PARAMS.indexOf(param) >= 0) c2[param] = v; else w2[param] = v;
      const cmpRes = compare(algos, w2, c2, runs, baseSeed);
      series.forEach(function (s) {
        const m = cmpRes.results[s.algo][metric];
        s.points.push({ x: v, mean: m.mean, ci: m.ci });
      });
    });
    return { param: param, metric: metric, series: series };
  }

  /* ------------------------------------------------------- Self-tests */
  function selfTests() {
    const tests = [];
    function check(name, ok, detail) { tests.push({ name: name, pass: !!ok, detail: detail || '' }); }
    const eq = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
    const col = function (r, k) { return r.processes.map(function (p) { return p[k]; }); };

    const ex = [{ pid: 'P1', arrival: 0, bursts: [5] }, { pid: 'P2', arrival: 2, bursts: [3] }, { pid: 'P3', arrival: 4, bursts: [8] }];
    let r = simulate('FCFS', ex);
    check('FCFS completion times (5, 8, 16)', eq(col(r, 'completion'), [5, 8, 16]), col(r, 'completion').join(','));
    check('FCFS turnaround (5, 6, 12) and waiting (0, 3, 4)', eq(col(r, 'tat'), [5, 6, 12]) && eq(col(r, 'wait'), [0, 3, 4]));
    check('FCFS average TAT = 23/3, context switches = 2', Math.abs(r.metrics.avgTAT - 23 / 3) < 1e-9 && r.metrics.ctxSwitches === 2);

    r = simulate('RR', ex, { quantum: 3 });
    check('RR q=3 completion (8, 6, 16)', eq(col(r, 'completion'), [8, 6, 16]), col(r, 'completion').join(','));
    check('RR q=3 waiting (3, 1, 4)', eq(col(r, 'wait'), [3, 1, 4]));

    const ex2 = [{ pid: 'P1', arrival: 0, bursts: [8] }, { pid: 'P2', arrival: 1, bursts: [4] }, { pid: 'P3', arrival: 2, bursts: [2] }];
    r = simulate('SRTF', ex2);
    check('SRTF completion (14, 7, 4), waiting (6, 2, 0)', eq(col(r, 'completion'), [14, 7, 4]) && eq(col(r, 'wait'), [6, 2, 0]), col(r, 'completion').join(','));
    r = simulate('SJF', ex2);
    check('SJF (non-preemptive) completion (8, 14, 10)', eq(col(r, 'completion'), [8, 14, 10]), col(r, 'completion').join(','));

    const pr = [{ pid: 'P1', arrival: 0, bursts: [5], priority: 2 }, { pid: 'P2', arrival: 1, bursts: [3], priority: 0 }, { pid: 'P3', arrival: 2, bursts: [1], priority: 1 }];
    r = simulate('PRIO_NP', pr);
    check('Priority non-preemptive completion (5, 8, 9)', eq(col(r, 'completion'), [5, 8, 9]), col(r, 'completion').join(','));
    r = simulate('PRIO_P', pr);
    check('Priority preemptive completion (9, 4, 5)', eq(col(r, 'completion'), [9, 4, 5]), col(r, 'completion').join(','));

    const ed = [{ pid: 'P1', arrival: 0, bursts: [4], deadline: 10 }, { pid: 'P2', arrival: 1, bursts: [2], deadline: 4 }];
    r = simulate('EDF', ed);
    check('EDF preempts for earlier deadline (CT 6, 3; no misses)', eq(col(r, 'completion'), [6, 3]) && r.metrics.deadlineMisses === 0);

    r = simulate('FCFS', [{ pid: 'Z', arrival: 3, bursts: [0] }, { pid: 'A', arrival: 3, bursts: [2] }]);
    check('Zero-CPU process completes immediately at arrival', r.processes[0].completion === 3 && r.processes[0].tat === 0);

    const wl = generateWorkload({ n: 40, seed: 7, arrivalRate: 0.05 });
    const a1 = simulate('FCFS', wl), a2 = simulate('RR', wl, { quantum: 100000 });
    check('Cross-check: RR with huge quantum matches FCFS', eq(col(a1, 'completion'), col(a2, 'completion')));

    let inv = true, why = '';
    Object.keys(ALGOS).forEach(function (id) {
      const x = simulate(id, wl, { quantum: 4, seed: 3 });
      const m = x.metrics;
      if (m.cpuUtil > 1 + 1e-9) { inv = false; why = id + ' util>1'; }
      if (m.busyTicks !== wl.reduce(function (s, p) { return s + p.cpuTotal; }, 0)) { inv = false; why = id + ' busy≠ΣCPU'; }
      x.processes.forEach(function (o) {
        if (o.completion < o.arrival + o.cpu + o.io) { inv = false; why = id + ' finished too early'; }
        if (o.wait < 0 || o.tat !== o.cpu + o.io + o.wait) { inv = false; why = id + ' TAT≠CPU+IO+wait'; }
      });
    });
    check('Invariants on all 11 schedulers (util ≤ 100%, TAT = CPU + I/O + wait, busy = ΣCPU)', inv, why);

    const b = simulate('RR', wl, { quantum: 4 }), c = simulate('RR', wl, { quantum: 4 });
    check('Deterministic: same seed → identical results', eq(b.metrics, c.metrics));

    const tt = pairedT([5, 6, 7, 8, 9, 10], [4, 5, 6, 7, 8, 9.5]);
    check('Paired t-test returns a valid p-value', tt.p > 0 && tt.p < 1, 'p=' + tt.p.toFixed(4));
    return tests;
  }

  return {
    ALGOS: ALGOS, METRICS: METRICS, DEFAULT_CFG: DEFAULT_CFG, DEFAULT_WL: DEFAULT_WL,
    simulate: simulate, generateWorkload: generateWorkload, normalize: normalize, estimateLoad: estimateLoad,
    compare: compare, sweep: sweep, pairedT: pairedT, selfTests: selfTests,
    stats: { mean: mean, std: std, ci95: ci95 }
  };
});
