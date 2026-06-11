// Read/write access to the CLI tracker (data/applications.md).
//
// Rules from CLAUDE.md / Pipeline Integrity:
//  - NEVER add rows to applications.md directly. New entries go through a TSV
//    in batch/tracker-additions/ and `node merge-tracker.mjs`.
//  - Updating the Status/Notes cells of an EXISTING row in place is allowed.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function trackerPath(root) {
  const dataPath = join(root, 'data', 'applications.md');
  if (existsSync(dataPath)) return dataPath;
  const rootPath = join(root, 'applications.md');
  if (existsSync(rootPath)) return rootPath;
  return dataPath; // default location for fresh setups
}

export function ensureTracker(root) {
  const file = trackerPath(root);
  if (existsSync(file)) return file;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    file,
    '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n'
  );
  return file;
}

function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  if (trimmed.startsWith('|---') || trimmed.startsWith('| #')) return null;
  let cells;
  if (trimmed.includes('\t')) {
    // Mixed format: leading "| " then tab-separated (legacy batch output)
    cells = trimmed.replace(/^\|/, '').trim().split('\t')
      .map(c => c.replace(/\|/g, '').trim());
  } else {
    const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    cells = inner.split('|').map(c => c.trim());
  }
  return cells.length >= 8 ? cells : null;
}

// Parse tracker rows. Column order in applications.md:
// # | Date | Company | Role | Score | Status | PDF | Report | Notes
export function parseApplications(root) {
  const file = trackerPath(root);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const apps = [];

  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (!cells) continue;
    const num = parseInt(cells[0], 10);
    if (Number.isNaN(num)) continue;

    const app = {
      num,
      date: cells[1] || '',
      company: cells[2] || '',
      role: cells[3] || '',
      scoreRaw: cells[4] || '',
      score: 0,
      status: cells[5] || '',
      hasPDF: (cells[6] || '').includes('✅'),
      reportPath: '',
      reportNumber: '',
      notes: cells[8] || '',
      line: i,
    };
    const sm = app.scoreRaw.match(/(\d+\.?\d*)\s*\/\s*5/);
    if (sm) app.score = parseFloat(sm[1]);
    const rm = (cells[7] || '').match(/\[(\d+)\]\(([^)]+)\)/);
    if (rm) {
      app.reportNumber = rm[1];
      app.reportPath = rm[2];
    }
    apps.push(app);
  }
  return apps;
}

export function normalizeCompany(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeRole(role) {
  return String(role || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Find a tracker row matching a job by number first, then company+role.
export function findTrackerApp(apps, job) {
  if (job.trackerNum) {
    const byNum = apps.find(a => a.num === job.trackerNum);
    if (byNum) return byNum;
  }
  const c = normalizeCompany(job.company);
  const r = normalizeRole(job.role);
  return apps.find(a => normalizeCompany(a.company) === c && normalizeRole(a.role) === r) || null;
}

// Update the Status cell (and optionally Notes) of an existing row in place.
export function updateTrackerRow(root, num, { status, notes } = {}) {
  const file = trackerPath(root);
  if (!existsSync(file)) throw new Error('tracker not found');
  const lines = readFileSync(file, 'utf8').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.startsWith('|---') || trimmed.startsWith('| #')) continue;
    if (trimmed.includes('\t')) continue; // legacy mixed rows: leave for normalize-statuses.mjs

    const hadTrailingPipe = trimmed.endsWith('|');
    const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    const cells = inner.split('|').map(c => c.trim());
    if (cells.length < 8) continue;
    if (parseInt(cells[0], 10) !== num) continue;

    if (status !== undefined) cells[5] = status;
    if (notes !== undefined) {
      const clean = String(notes).replace(/[\n|]/g, ' ');
      if (cells.length >= 9) cells[8] = clean;
      else cells.push(clean);
    }
    lines[i] = '| ' + cells.join(' | ') + (hadTrailingPipe ? ' |' : '');
    writeFileSync(file, lines.join('\n'));
    return true;
  }
  return false;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'job';
}

// Add a new tracker entry the sanctioned way: write a TSV addition and run
// merge-tracker.mjs. Returns the tracker row for the job after the merge.
export function addTrackerEntry(root, job, canonicalStatus, note = '') {
  ensureTracker(root);
  const additionsDir = join(root, 'batch', 'tracker-additions');
  mkdirSync(additionsDir, { recursive: true });

  const existing = parseApplications(root);
  let nextNum = existing.reduce((m, a) => Math.max(m, a.num), 0) + 1;
  // Account for pending, not-yet-merged additions
  for (const f of readdirSync(additionsDir)) {
    const m = f.match(/^(\d+)-.*\.tsv$/);
    if (m) nextNum = Math.max(nextNum, parseInt(m[1], 10) + 1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(job.company);
  const noteText = (note || `via web app — ${job.url || 'manual entry'}`).replace(/[\t\n|]/g, ' ');
  const row = [
    nextNum, date, job.company, job.role,
    canonicalStatus, '-', '❌', '-', noteText,
  ].join('\t');

  writeFileSync(join(additionsDir, `${nextNum}-${slug}.tsv`), row + '\n');
  execFileSync('node', [join(root, 'merge-tracker.mjs')], { cwd: root, stdio: 'pipe' });

  // merge-tracker may have deduped into an existing row — find where it landed
  const after = parseApplications(root);
  return findTrackerApp(after, job);
}
