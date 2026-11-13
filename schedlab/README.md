# SchedLab — CPU scheduling simulator (client + server)

A web app for the CPU Scheduling Simulator course project: 11 schedulers, workload generation,
the metrics from the brief, multi-run statistics with 95% confidence intervals, and a built-in validation suite.

## Run it

```bash
node server.js          # → http://localhost:3000   (Node 16+, no npm install needed)
npm test                # engine tests + live API tests
```

Or open `public/index.html` directly — with no server, everything runs in the browser.

## How client and server fit together

| Part | File | Role |
|---|---|---|
| Engine | `public/scheduler.js` | One file used by **both** sides (UMD): schedulers, workload generator, metrics, statistics, self-tests |
| Client | `public/index.html`, `app.js`, `style.css` | UI, Gantt timeline + playback, charts. Toggle **Browser / Server** in the header |
| Server | `server.js` | Serves the client, exposes the engine as a REST API, stores saved runs in `data/runs.json` |

If the server goes away mid-session, the client switches to the in-browser engine automatically.
Server and browser return identical results (tested).

### REST API
| Endpoint | Purpose |
|---|---|
| `GET /api/health`, `/api/algorithms`, `/api/selftest` | status, catalogue, validation suite |
| `POST /api/workload` `{params}` | generate processes |
| `POST /api/simulate` `{algorithm, config, processes, trace}` | one run: Gantt, queue log, per-process results, metrics |
| `POST /api/compare` `{algorithms, workload, config, runs, baseSeed}` | N replications → mean, std, 95% CI, raw samples |
| `POST /api/sweep` `{algorithms, workload, config, param, values, runs, metric}` | vary quantum / load / I-O mix / … |
| `GET/POST /api/runs`, `GET/DELETE /api/runs/:id` | saved runs |

## Schedulers
FCFS · SJF · SRTF · Round Robin · Priority (preemptive and non-preemptive, optional aging) · Multilevel Queue ·
Multilevel Feedback Queue (optional boost) · EDF · Lottery · Fair-Share.

## Metrics
Throughput, turnaround, waiting, response, CPU utilization, Jain fairness, max / 95th-percentile wait and
starved-process count, context switches (with optional switch cost), deadline misses, makespan.

## Conventions (also shown in the app)
- Lower priority number = higher priority. 1 tick = 1 time unit on a single CPU.
- A process whose quantum just expired queues *behind* processes arriving at that same instant.
- First dispatch is not counted as a context switch.
- With I/O: turnaround = CPU + I/O + waiting.

## Note on the project brief
The brief's Round Robin trace (quantum 3 on P1/P2/P3) is internally inconsistent (its two RR examples disagree, and neither
follows the standard queue order). Standard RR gives completion times 8, 6, 16 and waits 3, 1, 4; that's what the simulator
produces and what the test suite asserts.
