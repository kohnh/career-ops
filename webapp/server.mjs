#!/usr/bin/env node
// career-ops web app — local web UI over the same data files the CLI uses.
//
// Zero dependencies: node:http + static files. Personal data is served, so it
// binds to 127.0.0.1 by default (override with HOST/PORT env vars).
//
//   node webapp/server.mjs            # http://localhost:4949
//   PORT=8080 node webapp/server.mjs

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import {
  listJobs, getJobView, createJob, updateJob, setStage,
} from './lib/jobs.mjs';
import {
  isValidId, DOC_TYPES, readJd, writeJd, readDoc, writeDoc,
  readMainResume, writeMainResume, deleteJob, getJob,
} from './lib/store.mjs';
import { STAGES } from './lib/stages.mjs';

const WEBAPP_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CAREER_OPS_ROOT || dirname(WEBAPP_DIR);
const PUBLIC_DIR = join(WEBAPP_DIR, 'public');
const PORT = parseInt(process.env.PORT || '4949', 10);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Build a Claude-ready prompt to tailor the main resume / a cover letter to
// the saved JD. Used by the "copy prompt" button and the `claude -p` endpoint.
function tailorPrompt(root, id, type) {
  const job = getJobView(root, id);
  if (!job) return null;
  const cv = readMainResume(root);
  const jd = readJd(root, id);
  const what = type === 'resume'
    ? 'a tailored version of my resume'
    : 'a one-page cover letter';
  return [
    `You are helping me apply for the role of "${job.role}" at ${job.company}.`,
    `Write ${what} in clean markdown, tailored to this job description.`,
    'Rules: never invent experience, metrics, or skills that are not in my resume.',
    'Reorder and rephrase to emphasize what matches the JD. Output ONLY the markdown document, no commentary.',
    '',
    '--- MY MAIN RESUME (cv.md) ---',
    cv || '(cv.md is empty — ask me to fill it in first)',
    '',
    '--- JOB DESCRIPTION ---',
    jd || `(no JD saved — role: ${job.role} at ${job.company})`,
  ].join('\n');
}

// Optional AI generation: shells out to a local `claude -p` if available.
function generateWithClaude(prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', prompt], { timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') reject(Object.assign(new Error('claude CLI not found on this machine'), { status: 501 }));
        else reject(new Error(`claude failed: ${err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // GET /api/meta
  if (parts[1] === 'meta' && method === 'GET') {
    return send(res, 200, { stages: STAGES, root: ROOT });
  }

  // /api/resume — main resume (cv.md)
  if (parts[1] === 'resume' && parts.length === 2) {
    if (method === 'GET') return send(res, 200, { content: readMainResume(ROOT) });
    if (method === 'PUT') {
      const body = await readBody(req);
      writeMainResume(ROOT, String(body.content || ''));
      return send(res, 200, { ok: true });
    }
  }

  // GET /api/stats
  if (parts[1] === 'stats' && method === 'GET') {
    const jobs = listJobs(ROOT);
    const byStage = {};
    for (const s of STAGES) byStage[s.id] = 0;
    for (const j of jobs) byStage[j.stage] = (byStage[j.stage] || 0) + 1;
    const applied = jobs.filter(j => !['saved'].includes(j.stage)).length;
    const inProcess = byStage.oa + byStage.interview + byStage.offer;
    return send(res, 200, {
      total: jobs.length,
      byStage,
      applied,
      responseRate: applied ? Math.round((inProcess + byStage.rejected) / applied * 100) : 0,
      interviewRate: applied ? Math.round((byStage.interview + byStage.offer) / applied * 100) : 0,
      offerRate: applied ? Math.round(byStage.offer / applied * 100) : 0,
    });
  }

  // /api/jobs ...
  if (parts[1] === 'jobs') {
    // /api/jobs
    if (parts.length === 2) {
      if (method === 'GET') return send(res, 200, { jobs: listJobs(ROOT) });
      if (method === 'POST') {
        const body = await readBody(req);
        return send(res, 201, { job: createJob(ROOT, body) });
      }
    }

    const id = parts[2];
    if (!isValidId(id)) return send(res, 400, { error: 'invalid job id' });

    // /api/jobs/:id
    if (parts.length === 3) {
      if (method === 'GET') {
        const job = getJobView(ROOT, id);
        return job ? send(res, 200, { job }) : send(res, 404, { error: 'not found' });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const job = updateJob(ROOT, id, body);
        return job ? send(res, 200, { job }) : send(res, 404, { error: 'not found' });
      }
      if (method === 'DELETE') {
        return deleteJob(ROOT, id)
          ? send(res, 200, { ok: true })
          : send(res, 404, { error: 'not found' });
      }
    }

    // POST /api/jobs/:id/stage  {stage, round?, note?}
    if (parts.length === 4 && parts[3] === 'stage' && method === 'POST') {
      const body = await readBody(req);
      const job = setStage(ROOT, id, String(body.stage || ''), body.round, String(body.note || ''));
      return job ? send(res, 200, { job }) : send(res, 404, { error: 'not found' });
    }

    // /api/jobs/:id/jd
    if (parts.length === 4 && parts[3] === 'jd') {
      if (method === 'GET') return send(res, 200, { content: readJd(ROOT, id) });
      if (method === 'PUT') {
        const body = await readBody(req);
        if (!getJob(ROOT, id) && !getJobView(ROOT, id)) return send(res, 404, { error: 'not found' });
        writeJd(ROOT, id, String(body.content || ''));
        return send(res, 200, { ok: true });
      }
    }

    // /api/jobs/:id/documents/:type[ /from-main | /prompt | /generate ]
    if (parts.length >= 5 && parts[3] === 'documents') {
      const type = parts[4];
      if (!DOC_TYPES.includes(type)) return send(res, 400, { error: 'invalid document type' });

      if (parts.length === 5) {
        if (method === 'GET') return send(res, 200, { content: readDoc(ROOT, id, type) });
        if (method === 'PUT') {
          const body = await readBody(req);
          if (!getJob(ROOT, id) && !getJobView(ROOT, id)) return send(res, 404, { error: 'not found' });
          writeDoc(ROOT, id, type, String(body.content || ''));
          return send(res, 200, { ok: true });
        }
      }

      if (parts.length === 6 && method === 'POST') {
        if (parts[5] === 'from-main') {
          const cv = readMainResume(ROOT);
          writeDoc(ROOT, id, type, cv);
          return send(res, 200, { content: cv });
        }
        if (parts[5] === 'prompt') {
          const prompt = tailorPrompt(ROOT, id, type);
          return prompt ? send(res, 200, { prompt }) : send(res, 404, { error: 'not found' });
        }
        if (parts[5] === 'generate') {
          const prompt = tailorPrompt(ROOT, id, type);
          if (!prompt) return send(res, 404, { error: 'not found' });
          try {
            const content = await generateWithClaude(prompt);
            writeDoc(ROOT, id, type, content);
            return send(res, 200, { content });
          } catch (e) {
            return send(res, e.status || 500, { error: e.message });
          }
        }
      }
    }
  }

  return send(res, 404, { error: 'unknown endpoint' });
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  send(res, 200, readFileSync(file), MIME[extname(file)] || 'application/octet-stream');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (e) {
    const status = /required|invalid|too large/i.test(e.message) ? 400 : 500;
    return send(res, status, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`career-ops web app → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`data root: ${ROOT}`);
});
