// Unified job view: merges the web-app store (data/webapp/jobs.json) with the
// CLI tracker (data/applications.md) so jobs created by either side show up,
// and pushes stage changes back to both.

import {
  parseApplications, findTrackerApp, updateTrackerRow, addTrackerEntry,
  normalizeCompany, normalizeRole,
} from './tracker.mjs';
import {
  loadJobs, getJob, upsertJob, makeId, readJd, writeJd, docExists,
} from './store.mjs';
import { canonicalForStage, stageForCanonical, stageLabel, stageById } from './stages.mjs';

function decorate(root, job, trackerApp) {
  return {
    ...job,
    stageLabel: stageLabel(job.stage, job.round),
    score: trackerApp ? trackerApp.score : 0,
    reportPath: trackerApp ? trackerApp.reportPath : '',
    trackerStatus: trackerApp ? trackerApp.status : '',
    hasJd: readJd(root, job.id).length > 0,
    hasResume: docExists(root, job.id, 'resume'),
    hasCoverLetter: docExists(root, job.id, 'cover-letter'),
  };
}

// List all jobs: store records first, then tracker rows the store has never
// seen (evaluated/applied via the CLI), synthesized as read-through jobs.
export function listJobs(root) {
  const apps = parseApplications(root);
  const stored = loadJobs(root);
  const result = [];
  const seen = new Set();

  for (const job of stored) {
    const app = findTrackerApp(apps, job);
    if (app) seen.add(app.num);
    result.push(decorate(root, job, app));
  }

  for (const app of apps) {
    if (seen.has(app.num)) continue;
    // Same company+role already represented by a store job that matched a
    // different tracker row? Skip duplicates conservatively by company+role.
    const dup = stored.some(j =>
      normalizeCompany(j.company) === normalizeCompany(app.company) &&
      normalizeRole(j.role) === normalizeRole(app.role));
    if (dup) continue;

    result.push(decorate(root, {
      id: `tracker-${app.num}`,
      fromTracker: true,
      trackerNum: app.num,
      company: app.company,
      role: app.role,
      url: '',
      source: '',
      location: '',
      salary: '',
      notes: app.notes,
      stage: stageForCanonical(app.status),
      round: 0,
      history: [],
      createdAt: app.date ? `${app.date}T00:00:00.000Z` : '',
    }, app));
  }

  result.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  return result;
}

export function getJobView(root, id) {
  // Tracker-only synthetic jobs materialize into the store on first touch
  const job = getJob(root, id) || materializeTrackerJob(root, id);
  if (!job) return null;
  const app = findTrackerApp(parseApplications(root), job);
  return decorate(root, job, app);
}

function materializeTrackerJob(root, id) {
  const m = String(id).match(/^tracker-(\d+)$/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  const app = parseApplications(root).find(a => a.num === num);
  if (!app) return null;
  return {
    id,
    trackerNum: num,
    company: app.company,
    role: app.role,
    url: '',
    source: '',
    location: '',
    salary: '',
    notes: app.notes,
    stage: stageForCanonical(app.status),
    round: 0,
    history: [],
    createdAt: new Date().toISOString(),
  };
}

export function createJob(root, input) {
  const company = String(input.company || '').trim();
  const role = String(input.role || '').trim();
  if (!company || !role) throw new Error('company and role are required');

  const job = {
    id: makeId(root, company, role),
    company,
    role,
    url: String(input.url || '').trim(),
    source: String(input.source || '').trim(),
    location: String(input.location || '').trim(),
    salary: String(input.salary || '').trim(),
    notes: String(input.notes || '').trim(),
    stage: 'saved',
    round: 0,
    history: [],
    createdAt: new Date().toISOString(),
  };
  pushHistory(job, 'saved', 0, 'Job saved');

  if (input.jd) writeJd(root, job.id, String(input.jd));
  upsertJob(root, job);

  // If created directly in a post-application stage, sync to tracker too
  const stage = String(input.stage || 'saved');
  if (stage !== 'saved') {
    return setStage(root, job.id, stage, parseInt(input.round, 10) || 0, '');
  }
  const app = findTrackerApp(parseApplications(root), job);
  return decorate(root, job, app);
}

export function updateJob(root, id, patch) {
  const job = getJob(root, id) || materializeTrackerJob(root, id);
  if (!job) return null;
  for (const key of ['company', 'role', 'url', 'source', 'location', 'salary', 'notes']) {
    if (patch[key] !== undefined) job[key] = String(patch[key]).trim();
  }
  upsertJob(root, job);
  const apps = parseApplications(root);
  const app = findTrackerApp(apps, job);
  if (app && patch.notes !== undefined) {
    updateTrackerRow(root, app.num, { notes: job.notes });
  }
  return decorate(root, job, app);
}

function pushHistory(job, stage, round, note) {
  job.history = job.history || [];
  job.history.push({
    stage,
    round: round || 0,
    label: stageLabel(stage, round),
    date: new Date().toISOString(),
    note: note || '',
  });
}

// Move a job to a new stage. Keeps the CLI tracker in sync:
//  - job not in tracker + stage maps to a canonical state → add via
//    batch/tracker-additions + merge-tracker.mjs (per pipeline rules)
//  - job already in tracker → update the Status cell in place
export function setStage(root, id, stage, round = 0, note = '') {
  const job = getJob(root, id) || materializeTrackerJob(root, id);
  if (!job) return null;
  if (!stageById(stage)) throw new Error(`unknown stage: ${stage}`);
  const canonical = canonicalForStage(stage);

  job.stage = stage;
  job.round = stage === 'interview' ? (parseInt(round, 10) || 0) : 0;
  pushHistory(job, stage, job.round, note);

  let app = findTrackerApp(parseApplications(root), job);
  if (canonical) {
    if (app) {
      updateTrackerRow(root, app.num, { status: canonical });
    } else {
      app = addTrackerEntry(root, job, canonical, note);
    }
    if (app) job.trackerNum = app.num;
  }
  upsertJob(root, job);
  return decorate(root, job, app);
}
