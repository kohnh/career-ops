// Web-app job store: data/webapp/jobs.json plus per-job document files.
//
// User-layer data (see DATA_CONTRACT.md): never touched by system updates.
//  - data/webapp/jobs.json                      job records + stage history
//  - data/webapp/documents/{id}/resume.md       tailored resume
//  - data/webapp/documents/{id}/cover-letter.md tailored cover letter
//  - jds/{id}.md                                saved job description (CLI convention)

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const DOC_TYPES = ['resume', 'cover-letter'];

export function isValidId(id) {
  return ID_RE.test(String(id || ''));
}

function storeFile(root) {
  return join(root, 'data', 'webapp', 'jobs.json');
}

export function loadJobs(root) {
  const file = storeFile(root);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

export function saveJobs(root, jobs) {
  const file = storeFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify({ jobs }, null, 2) + '\n');
  renameSync(tmp, file);
}

export function makeId(root, company, role) {
  const base = `${company} ${role}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const jobs = loadJobs(root);
  let id = base || `job-${randomBytes(3).toString('hex')}`;
  while (jobs.some(j => j.id === id)) {
    id = `${base}-${randomBytes(2).toString('hex')}`;
  }
  return id;
}

export function getJob(root, id) {
  return loadJobs(root).find(j => j.id === id) || null;
}

export function upsertJob(root, job) {
  const jobs = loadJobs(root);
  const idx = jobs.findIndex(j => j.id === job.id);
  job.updatedAt = new Date().toISOString();
  if (idx >= 0) jobs[idx] = job;
  else jobs.push(job);
  saveJobs(root, jobs);
  return job;
}

export function deleteJob(root, id) {
  const jobs = loadJobs(root);
  const next = jobs.filter(j => j.id !== id);
  if (next.length === jobs.length) return false;
  saveJobs(root, next);
  rmSync(join(root, 'data', 'webapp', 'documents', id), { recursive: true, force: true });
  rmSync(jdPath(root, id), { force: true });
  return true;
}

// --- Job descriptions (saved into jds/, the CLI's JD directory) ---

export function jdPath(root, id) {
  return join(root, 'jds', `${id}.md`);
}

export function readJd(root, id) {
  const file = jdPath(root, id);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function writeJd(root, id, content) {
  mkdirSync(join(root, 'jds'), { recursive: true });
  writeFileSync(jdPath(root, id), content);
}

// --- Tailored documents ---

export function docPath(root, id, type) {
  return join(root, 'data', 'webapp', 'documents', id, `${type}.md`);
}

export function readDoc(root, id, type) {
  const file = docPath(root, id, type);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function writeDoc(root, id, type, content) {
  const file = docPath(root, id, type);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function docExists(root, id, type) {
  return existsSync(docPath(root, id, type));
}

// --- Main resume (cv.md — canonical CV per CLAUDE.md) ---

export function readMainResume(root) {
  const file = join(root, 'cv.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export function writeMainResume(root, content) {
  writeFileSync(join(root, 'cv.md'), content);
}
