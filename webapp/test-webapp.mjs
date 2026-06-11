#!/usr/bin/env node
// Tests for the web app backend. Runs against a throwaway temp root so real
// user data is never touched.  Run: node webapp/test-webapp.mjs

import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureTracker, parseApplications, updateTrackerRow, normalizeCompany,
} from './lib/tracker.mjs';
import {
  loadJobs, upsertJob, getJob, deleteJob, makeId, writeJd, readJd,
  writeDoc, readDoc, isValidId, readMainResume, writeMainResume,
} from './lib/store.mjs';
import { canonicalForStage, stageForCanonical, stageLabel } from './lib/stages.mjs';
import { createJob, setStage, listJobs, updateJob, getJobView } from './lib/jobs.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = mkdtempSync(join(tmpdir(), 'careerops-webapp-test-'));

// addTrackerEntry shells out to {root}/merge-tracker.mjs — provide it
copyFileSync(join(REPO, 'merge-tracker.mjs'), join(ROOT, 'merge-tracker.mjs'));
copyFileSync(join(REPO, 'tracker-links.mjs'), join(ROOT, 'tracker-links.mjs'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name) { console.log(`\n${name}`); }

// --- stages ---
section('stages');
check('applied → Applied', canonicalForStage('applied') === 'Applied');
check('oa → Responded', canonicalForStage('oa') === 'Responded');
check('interview → Interview', canonicalForStage('interview') === 'Interview');
check('closed → Discarded', canonicalForStage('closed') === 'Discarded');
check('saved → null (not tracker-worthy)', canonicalForStage('saved') === null);
check('Evaluated → saved column', stageForCanonical('Evaluated') === 'saved');
check('Responded → oa column', stageForCanonical('Responded') === 'oa');
check('SKIP → closed column', stageForCanonical('SKIP') === 'closed');
check('aplicado alias → applied', stageForCanonical('aplicado') === 'applied');
check('bold+date stripped', stageForCanonical('**Applied** 2026-01-02') === 'applied');
check('round label', stageLabel('interview', 2) === 'Round 2');

// --- tracker ---
section('tracker');
ensureTracker(ROOT);
check('tracker created at data/applications.md', existsSync(join(ROOT, 'data', 'applications.md')));

writeFileSync(join(ROOT, 'data', 'applications.md'),
  '# Applications Tracker\n\n' +
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
  '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
  '| 1 | 2026-06-01 | Acme | Backend Engineer | 4.2/5 | Evaluated | ✅ | [001](../reports/001-acme-2026-06-01.md) | strong fit |\n' +
  '| 2 | 2026-06-02 | Globex | Data Engineer | 3.1/5 | Applied | ❌ | - | no trailing pipe row\n');

let apps = parseApplications(ROOT);
check('parses 2 rows', apps.length === 2);
check('score parsed', apps[0].score === 4.2);
check('status parsed', apps[0].status === 'Evaluated');
check('report link parsed', apps[0].reportNumber === '001');
check('row without trailing pipe keeps notes', apps[1].notes === 'no trailing pipe row');

check('update status in place', updateTrackerRow(ROOT, 1, { status: 'Applied' }) === true);
apps = parseApplications(ROOT);
check('status updated', apps[0].status === 'Applied');
check('other cells untouched', apps[0].company === 'Acme' && apps[0].reportNumber === '001');
updateTrackerRow(ROOT, 2, { notes: 'updated note' });
check('notes updated', parseApplications(ROOT)[1].notes === 'updated note');
check('normalizeCompany strips noise', normalizeCompany('Acme, Inc.') === 'acmeinc');

// --- store ---
section('store');
check('id validation accepts slug', isValidId('acme-backend-engineer'));
check('id validation rejects traversal', !isValidId('../etc') && !isValidId('a/b') && !isValidId(''));
const jid = makeId(ROOT, 'Test Co', 'Platform Engineer');
check('makeId slugifies', jid === 'test-co-platform-engineer');
upsertJob(ROOT, { id: jid, company: 'Test Co', role: 'Platform Engineer', stage: 'saved', history: [] });
check('upsert + get', getJob(ROOT, jid)?.company === 'Test Co');
writeJd(ROOT, jid, '# JD\nGreat job');
check('JD saved under jds/', readJd(ROOT, jid).includes('Great job') && existsSync(join(ROOT, 'jds', `${jid}.md`)));
writeDoc(ROOT, jid, 'resume', '# Tailored');
check('doc roundtrip', readDoc(ROOT, jid, 'resume') === '# Tailored');
writeMainResume(ROOT, '# Jane Doe\n\n## Experience\n- Built things');
check('main resume = cv.md', readMainResume(ROOT).startsWith('# Jane Doe') && existsSync(join(ROOT, 'cv.md')));
check('delete removes record + files', deleteJob(ROOT, jid) && !getJob(ROOT, jid) && !existsSync(join(ROOT, 'jds', `${jid}.md`)));

// --- jobs service ---
section('jobs service');
const job = createJob(ROOT, {
  company: 'Initech', role: 'Senior SRE', url: 'https://example.com/job',
  source: 'LinkedIn', jd: 'Run the pagers',
});
check('created in saved stage', job.stage === 'saved');
check('JD stored on create', readJd(ROOT, job.id) === 'Run the pagers');
check('saved job NOT in tracker', !parseApplications(ROOT).some(a => a.company === 'Initech'));

const applied = setStage(ROOT, job.id, 'applied', 0, 'sent via portal');
check('applied syncs to tracker via merge-tracker', parseApplications(ROOT).some(a => a.company === 'Initech' && a.status === 'Applied'));
check('trackerNum recorded', applied.trackerNum > 0);
check('history grows', applied.history.length === 2);

const oa = setStage(ROOT, job.id, 'oa');
check('OA maps to Responded in tracker', parseApplications(ROOT).find(a => a.num === applied.trackerNum)?.status === 'Responded');
check('OA stage kept in store', oa.stage === 'oa');

const r2 = setStage(ROOT, job.id, 'interview', 2, 'system design');
check('round stored', r2.round === 2 && r2.stageLabel === 'Round 2');
check('interview maps to Interview', parseApplications(ROOT).find(a => a.num === applied.trackerNum)?.status === 'Interview');

setStage(ROOT, job.id, 'rejected');
check('rejected synced', parseApplications(ROOT).find(a => a.num === applied.trackerNum)?.status === 'Rejected');

// tracker-only rows appear in listJobs
const all = listJobs(ROOT);
const trackerOnly = all.find(j => j.company === 'Acme');
check('tracker-only row listed', !!trackerOnly && trackerOnly.id.startsWith('tracker-'));
check('tracker-only stage derived from status', trackerOnly.stage === 'applied');
check('no duplicate for store-backed job', all.filter(j => normalizeCompany(j.company) === 'initech').length === 1);

// stage change on tracker-only job materializes it + updates tracker
const mat = setStage(ROOT, trackerOnly.id, 'interview', 1);
check('tracker-only job materialized', !!getJob(ROOT, trackerOnly.id));
check('tracker status updated for materialized job', parseApplications(ROOT).find(a => a.num === 1)?.status === 'Interview');
check('getJobView reflects merge', getJobView(ROOT, trackerOnly.id)?.stage === 'interview');

const patched = updateJob(ROOT, job.id, { notes: 'final note', salary: '150k' });
check('patch fields', patched.salary === '150k' && patched.notes === 'final note');

// --- summary ---
rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
