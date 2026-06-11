// Bridge between the web app and the CLI scripts at the repo root.
//
// Everything here shells out to the SAME scripts the CLI uses (scan.mjs,
// check-liveness.mjs, batch-runner.sh, ...) — nothing is re-implemented, so
// behavior stays identical between terminal and browser.
//
// Commands are strictly allowlisted; the only user-controlled argv values are
// validated (URLs, company names) and passed as separate argv entries, never
// through a shell string.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const MAX_OUTPUT = 200 * 1024; // per-run output cap
const MAX_RUNS = 50;

// ---------- allowlisted tools ----------

const COMPANY_RE = /^[\w .&'-]{1,60}$/;

function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// Each tool builds an argv array from validated options. `bin` + `script`
// are fixed; only vetted values are appended.
export const TOOLS = {
  scan: {
    label: 'Portal scanner',
    description: 'scan.mjs — hit Greenhouse/Ashby/Lever APIs for new offers (writes data/pipeline.md + scan-history)',
    build(root, opts = {}) {
      const args = [join(root, 'scan.mjs')];
      if (opts.dryRun) args.push('--dry-run');
      if (opts.company) {
        if (!COMPANY_RE.test(opts.company)) throw new Error('invalid company name');
        args.push('--company', opts.company);
      }
      return { bin: 'node', args };
    },
  },
  doctor: {
    label: 'Doctor',
    description: 'doctor.mjs — setup validation checklist',
    build(root) { return { bin: 'node', args: [join(root, 'doctor.mjs')] }; },
  },
  verify: {
    label: 'Verify pipeline',
    description: 'verify-pipeline.mjs — tracker integrity health check',
    build(root) { return { bin: 'node', args: [join(root, 'verify-pipeline.mjs')] }; },
  },
  normalize: {
    label: 'Normalize statuses',
    description: 'normalize-statuses.mjs — rewrite non-canonical statuses',
    build(root) { return { bin: 'node', args: [join(root, 'normalize-statuses.mjs')] }; },
  },
  dedup: {
    label: 'Dedup tracker',
    description: 'dedup-tracker.mjs — remove duplicate company+role rows',
    build(root) { return { bin: 'node', args: [join(root, 'dedup-tracker.mjs')] }; },
  },
  merge: {
    label: 'Merge tracker additions',
    description: 'merge-tracker.mjs — merge batch/tracker-additions into the tracker',
    build(root) { return { bin: 'node', args: [join(root, 'merge-tracker.mjs')] }; },
  },
  patterns: {
    label: 'Rejection patterns',
    description: 'analyze-patterns.mjs --summary — outcome patterns across applications',
    build(root) { return { bin: 'node', args: [join(root, 'analyze-patterns.mjs'), '--summary'] }; },
  },
  followups: {
    label: 'Follow-up cadence',
    description: 'followup-cadence.mjs --summary — who to ping, and when',
    build(root) { return { bin: 'node', args: [join(root, 'followup-cadence.mjs'), '--summary'] }; },
  },
  'update-check': {
    label: 'Check for updates',
    description: 'update-system.mjs check — compare local VERSION against GitHub',
    build(root) { return { bin: 'node', args: [join(root, 'update-system.mjs'), 'check'] }; },
  },
  liveness: {
    label: 'Liveness check',
    description: 'check-liveness.mjs — Playwright check whether posting URLs are still active',
    build(root, opts = {}) {
      const urls = (opts.urls || []).filter(Boolean);
      if (!urls.length || !urls.every(isHttpUrl)) throw new Error('one or more valid http(s) URLs required');
      if (urls.length > 20) throw new Error('max 20 URLs per run');
      return { bin: 'node', args: [join(root, 'check-liveness.mjs'), ...urls] };
    },
  },
  batch: {
    label: 'Batch evaluate (claude -p)',
    description: 'batch/batch-runner.sh — full AI evaluation of pending batch-input.tsv offers via headless Claude workers',
    build(root) { return { bin: 'bash', args: [join(root, 'batch', 'batch-runner.sh')] }; },
  },
};

// ---------- run registry (in-memory) ----------

const runs = new Map();

export function listRuns() {
  return [...runs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(({ proc, ...rest }) => rest);
}

export function getRun(id) {
  const run = runs.get(id);
  if (!run) return null;
  const { proc, ...rest } = run;
  return rest;
}

export function startTool(root, tool, opts = {}) {
  const def = TOOLS[tool];
  if (!def) throw new Error(`unknown tool: ${tool}`);
  const { bin, args } = def.build(root, opts);
  const scriptPath = args[0];
  if (!existsSync(scriptPath)) throw new Error(`script not found: ${scriptPath}`);
  return startRun(root, tool, bin, args);
}

export function startRun(root, tool, bin, args) {
  // Don't run the same tool twice concurrently
  for (const r of runs.values()) {
    if (r.tool === tool && r.status === 'running') {
      throw new Error(`${tool} is already running (run ${r.id})`);
    }
  }

  const id = randomBytes(6).toString('hex');
  const run = {
    id, tool,
    command: `${bin} ${args.join(' ')}`,
    status: 'running',
    output: '',
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };

  const proc = spawn(bin, args, { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  run.proc = proc;

  const append = chunk => {
    run.output += chunk.toString();
    if (run.output.length > MAX_OUTPUT) {
      run.output = run.output.slice(-MAX_OUTPUT);
    }
  };
  proc.stdout.on('data', append);
  proc.stderr.on('data', append);
  proc.on('error', err => {
    run.status = 'error';
    run.output += `\n[spawn error] ${err.message}`;
    run.endedAt = new Date().toISOString();
  });
  proc.on('close', code => {
    run.exitCode = code;
    run.status = code === 0 ? 'done' : 'error';
    run.endedAt = new Date().toISOString();
  });

  runs.set(id, run);
  // Evict oldest finished runs beyond the cap
  if (runs.size > MAX_RUNS) {
    const finished = [...runs.values()].filter(r => r.status !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const r of finished.slice(0, runs.size - MAX_RUNS)) runs.delete(r.id);
  }
  const { proc: _p, ...rest } = run;
  return rest;
}

// ---------- pipeline inbox (data/pipeline.md) ----------

function pipelinePath(root) {
  return join(root, 'data', 'pipeline.md');
}

export function readPipeline(root) {
  const file = pipelinePath(root);
  const result = { pending: [], errors: [], processed: [] };
  if (!existsSync(file)) return result;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^- \[ \] (.+)$/))) {
      const [url, company, role] = m[1].split('|').map(s => s.trim());
      result.pending.push({ url, company: company || '', role: role || '' });
    } else if ((m = t.match(/^- \[!\] (.+)$/))) {
      result.errors.push({ raw: m[1] });
    } else if ((m = t.match(/^- \[x\] (.+)$/))) {
      result.processed.push({ raw: m[1] });
    }
  }
  return result;
}

export function addToPipeline(root, url, company = '', role = '') {
  if (!isHttpUrl(url)) throw new Error('valid http(s) URL required');
  const file = pipelinePath(root);
  mkdirSync(join(root, 'data'), { recursive: true });

  const existing = readPipeline(root);
  if (existing.pending.some(p => p.url === url)) return { added: false, reason: 'already pending' };

  const clean = s => String(s || '').replace(/[|\n]/g, ' ').trim();
  const entry = ['- [ ] ' + url, clean(company), clean(role)].filter(Boolean).join(' | ');

  if (!existsSync(file)) {
    writeFileSync(file, `# Pipeline — URL Inbox\n\n## Pending\n${entry}\n\n## Processed\n`);
    return { added: true };
  }

  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const idx = lines.findIndex(l => /^##\s*Pending/i.test(l.trim()));
  if (idx >= 0) {
    lines.splice(idx + 1, 0, entry);
    writeFileSync(file, lines.join('\n'));
  } else {
    appendFileSync(file, `\n## Pending\n${entry}\n`);
  }
  return { added: true };
}

// ---------- reports ----------

const REPORT_NAME_RE = /^[\w.-]+\.md$/;

export function listReports(root) {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && REPORT_NAME_RE.test(f) && !f.endsWith('-RESERVED.md'))
    .map(f => {
      const st = statSync(join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function readReport(root, name) {
  if (!REPORT_NAME_RE.test(name)) throw new Error('invalid report name');
  const file = join(root, 'reports', name);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

// ---------- batch enqueue (per-job AI evaluation) ----------

// Append a job to batch/batch-input.tsv (id \t url \t source \t notes) and
// stage its saved JD where batch-runner.sh expects it (/tmp/batch-jd-{id}.txt),
// then start the runner. The runner does everything else: report number
// reservation, claude -p worker, tracker TSV, retries.
export function enqueueBatchEvaluation(root, job, jdText = '') {
  if (!job.url || !isHttpUrl(job.url)) {
    throw new Error('job needs a valid posting URL to be evaluated');
  }
  const inputFile = join(root, 'batch', 'batch-input.tsv');
  mkdirSync(join(root, 'batch'), { recursive: true });

  let nextId = 1;
  const lines = existsSync(inputFile) ? readFileSync(inputFile, 'utf8').split('\n') : [];
  for (const line of lines) {
    const id = parseInt(line.split('\t')[0], 10);
    if (!Number.isNaN(id)) nextId = Math.max(nextId, id + 1);
  }

  const clean = s => String(s || '').replace(/[\t\n|]/g, ' ').trim();
  const notes = `${clean(job.role)} @ ${clean(job.company)} | - | ${job.url}`;
  appendFileSync(inputFile, `${nextId}\t${job.url}\twebapp\t${notes}\n`);

  if (jdText) writeFileSync(`/tmp/batch-jd-${nextId}.txt`, jdText);

  const run = startTool(root, 'batch');
  return { batchId: nextId, run };
}

// ---------- markdown → HTML (for report viewing and PDF export) ----------

// Minimal converter — covers the markdown these files actually use:
// headings, bold/italic, links, lists, tables, hr, code spans, paragraphs.
export function mdToHtml(md) {
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, h) =>
      /^https?:\/\//.test(h) ? `<a href="${h}" target="_blank" rel="noopener">${t}</a>` : t);

  const lines = String(md).split('\n');
  const out = [];
  let inList = false, inTable = false, para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeTable = () => { if (inTable) { out.push('</table>'); inTable = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    let m;
    if (!t) { flushPara(); closeList(); closeTable(); continue; }
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); closeList(); closeTable();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara(); closeList(); closeTable();
      out.push('<hr>');
    } else if ((m = t.match(/^[-*]\s+(.*)$/))) {
      flushPara(); closeTable();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (t.startsWith('|')) {
      flushPara(); closeList();
      if (/^\|[\s:|-]+\|$/.test(t)) continue; // separator row
      if (!inTable) { out.push('<table>'); inTable = true; }
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => `<td>${inline(c.trim())}</td>`);
      out.push(`<tr>${cells.join('')}</tr>`);
    } else {
      closeList(); closeTable();
      para.push(t);
    }
  }
  flushPara(); closeList(); closeTable();
  return out.join('\n');
}
