# career-ops web app

A local web UI for the career-ops pipeline. Zero dependencies — plain Node.js,
no build step. It reads and writes **the same files the CLI uses**, so you can
mix both freely: evaluate offers with Claude Code, drag them through stages in
the browser.

```bash
npm run web          # → http://localhost:4949
npm run test:web     # backend test suite (runs in a temp dir, never touches your data)
```

`PORT` and `HOST` env vars override the defaults (`4949`, `127.0.0.1`). The
server binds to localhost only because it serves your personal data with no
auth — don't expose it.

## What it does

- **Board** — kanban view of every job across stages: Saved → Applied → OA →
  Interview (with round numbers: Round 1, Round 2, …) → Offer / Rejected /
  Closed. Drag cards between columns, or use the stage buttons in the detail
  drawer. Search filters by company/role/location/source.
- **Track openings from anywhere** — add jobs manually from LinkedIn, Indeed,
  referrals, etc. with URL, source, location, salary, and the full job
  description (saved to `jds/`, the same directory the CLI pipeline uses).
- **Main resume** — edit `cv.md` (the canonical CV for the whole pipeline)
  directly in the browser.
- **Tailored documents** — per-job custom resume and cover letter (markdown).
  Start from the main resume, edit by hand, copy a ready-made tailoring prompt
  for Claude, or click *Generate with Claude* (shells out to a local
  `claude -p` if installed). Download as `.md`.
- **Stage history** — every transition is timestamped with optional notes
  (e.g. "OA: 90 min HackerRank", "Round 2: system design").
- **Stats** — applications sent, response/interview/offer rates, stage funnel.
- **Inbox** — view and add URLs in `data/pipeline.md` (the CLI's URL inbox).
  Process them with `/career-ops pipeline` in Claude Code, or evaluate
  individual jobs straight from the board.
- **Reports** — browse and read the evaluation reports in `reports/`.
- **Tools** — run the CLI scripts from the browser with a live output console:
  portal scanner (`scan.mjs`, with dry-run / single-company options), doctor,
  pipeline verify, status normalization, dedup, tracker merge, rejection
  patterns, follow-up cadence, update check, liveness checks, and the batch
  evaluator. Nothing is re-implemented — the web app shells out to the exact
  same scripts, allowlisted and with validated arguments.
- **Per-job CLI actions** (in the job drawer): *Check liveness*
  (`check-liveness.mjs`), *Add to inbox*, *View report*, and *Evaluate with
  Claude* — a full A–G evaluation + report + tracker entry via
  `batch/batch-runner.sh` headless workers (requires the `claude` CLI).
- **Export PDF** — render a tailored resume/cover letter to an ATS-friendly
  PDF in `output/` via the repo's `generate-pdf.mjs` (requires Playwright
  Chromium: `npx playwright install chromium`).

## How it stays in sync with the CLI

| Data | File | Owner |
|------|------|-------|
| Application tracker | `data/applications.md` | shared with CLI |
| Main resume | `cv.md` | shared with CLI |
| Job descriptions | `jds/{job-id}.md` | shared with CLI |
| Job records, stage history | `data/webapp/jobs.json` | web app (user layer) |
| Tailored resume / cover letter | `data/webapp/documents/{job-id}/*.md` | web app (user layer) |

The tracker only knows the canonical states from `templates/states.yml`, so
extended stages are projected onto them:

| Web app stage | Tracker status |
|---------------|----------------|
| Saved | *(not in tracker yet)* |
| Applied | `Applied` |
| OA | `Responded` |
| Interview / Round N | `Interview` |
| Offer | `Offer` |
| Rejected | `Rejected` |
| Closed | `Discarded` |

The detailed stage (which round, when, notes) lives in
`data/webapp/jobs.json`; the tracker carries the canonical projection.

Pipeline-integrity rules are respected: new tracker rows are **never**
appended directly — the server writes a TSV to `batch/tracker-additions/` and
runs `node merge-tracker.mjs`, exactly like a batch worker would. Status
changes on existing rows are edited in place (allowed). Jobs evaluated via the
CLI show up on the board automatically (in the column matching their tracker
status) and can be managed from the browser from then on.

## API

REST under `/api`:

```
GET    /api/meta                              stages + data root
GET    /api/jobs                              merged job list (store + tracker)
POST   /api/jobs                              create {company, role, url?, source?, location?, salary?, notes?, jd?, stage?}
GET    /api/jobs/:id                          one job
PATCH  /api/jobs/:id                          update fields
DELETE /api/jobs/:id                          delete web-app record (+JD/docs); tracker row is kept
POST   /api/jobs/:id/stage                    {stage, round?, note?} — syncs tracker
GET/PUT /api/jobs/:id/jd                      job description (jds/{id}.md)
GET/PUT /api/jobs/:id/documents/:type         type = resume | cover-letter
POST   /api/jobs/:id/documents/:type/from-main  seed from cv.md
POST   /api/jobs/:id/documents/:type/prompt     Claude-ready tailoring prompt
POST   /api/jobs/:id/documents/:type/generate   run `claude -p` locally (501 if not installed)
POST   /api/jobs/:id/liveness                 check-liveness.mjs on the job URL → run
POST   /api/jobs/:id/inbox                    add job URL to data/pipeline.md
POST   /api/jobs/:id/evaluate                 enqueue batch-input.tsv + start batch-runner.sh → run
POST   /api/jobs/:id/documents/:type/pdf      render to output/{id}-{type}.pdf (generate-pdf.mjs)
GET/PUT /api/resume                           main resume (cv.md)
GET    /api/stats                             funnel + rates
GET    /api/tools                             allowlisted CLI tools
POST   /api/tools/:tool                       start a tool run (scan accepts {dryRun, company}; liveness {urls})
GET    /api/runs, /api/runs/:id               run status + captured output
GET/POST /api/pipeline                        URL inbox (data/pipeline.md)
GET    /api/reports, /api/reports/:name       evaluation reports (raw + rendered HTML)
GET    /api/output/:name.pdf                  download generated PDFs
```

Long-running tools (scan, batch evaluation) run as background processes; the
UI polls `/api/runs/:id` and streams output into the Tools console. Only one
run per tool at a time.
