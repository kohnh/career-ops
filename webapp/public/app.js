/* career-ops web app frontend (no framework, no build step) */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let STAGES = [];
let JOBS = [];
let CURRENT = null; // job open in the drawer

// ---------- API ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// ---------- toast ----------

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// ---------- views ----------

function showView(name) {
  $$('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'stats') renderStats();
  if (name === 'resume') loadResume();
}

$$('.navbtn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- board ----------

function jobMatchesSearch(job, q) {
  if (!q) return true;
  return `${job.company} ${job.role} ${job.location} ${job.source}`.toLowerCase().includes(q);
}

function cardEl(job) {
  const card = document.createElement('div');
  card.className = 'card';
  card.draggable = true;
  card.dataset.id = job.id;

  const badges = [];
  if (job.stage === 'interview' && job.round > 0) badges.push(`<span class="badge round">Round ${job.round}</span>`);
  if (job.source) badges.push(`<span class="badge src">${esc(job.source)}</span>`);
  if (job.location) badges.push(`<span class="badge">${esc(job.location)}</span>`);
  if (job.score > 0) badges.push(`<span class="badge score">★ ${job.score.toFixed(1)}</span>`);
  if (job.hasJd) badges.push('<span class="badge doc">JD</span>');
  if (job.hasResume) badges.push('<span class="badge doc">CV</span>');
  if (job.hasCoverLetter) badges.push('<span class="badge doc">CL</span>');

  card.innerHTML = `
    <div class="role">${esc(job.role)}</div>
    <div class="company">${esc(job.company)}</div>
    <div class="badges">${badges.join('')}</div>`;

  card.addEventListener('click', () => openDrawer(job.id));
  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', job.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  return card;
}

function renderBoard() {
  const q = $('#search').value.trim().toLowerCase();
  const board = $('#board');
  board.innerHTML = '';

  for (const stage of STAGES) {
    const jobs = JOBS.filter(j => j.stage === stage.id && jobMatchesSearch(j, q));
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.stage = stage.id;
    col.innerHTML = `
      <div class="col-head"><span>${esc(stage.label)}</span><span class="count">${jobs.length}</span></div>
      <div class="col-body"></div>`;
    const body = $('.col-body', col);
    jobs.forEach(j => body.appendChild(cardEl(j)));

    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/plain');
      const job = JOBS.find(j => j.id === id);
      if (!job || job.stage === stage.id) return;
      try {
        const round = stage.id === 'interview' ? Math.max(job.round, 1) : 0;
        await api(`/api/jobs/${id}/stage`, { method: 'POST', body: { stage: stage.id, round } });
        await refresh();
        toast(`${job.company} → ${stage.label}`);
      } catch (err) { toast(err.message, true); }
    });

    board.appendChild(col);
  }
}

async function refresh() {
  const data = await api('/api/jobs');
  JOBS = data.jobs;
  renderBoard();
  if (CURRENT) {
    const updated = JOBS.find(j => j.id === CURRENT.id || j.trackerNum === CURRENT.trackerNum && CURRENT.trackerNum);
    if (updated) fillDrawer(updated);
  }
}

$('#search').addEventListener('input', renderBoard);

// ---------- add job ----------

$('#add-job-btn').addEventListener('click', () => $('#add-modal').classList.remove('hidden'));
$('#add-cancel').addEventListener('click', () => $('#add-modal').classList.add('hidden'));
$('#add-modal').addEventListener('click', e => {
  if (e.target === $('#add-modal')) $('#add-modal').classList.add('hidden');
});

$('#add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    await api('/api/jobs', { method: 'POST', body });
    form.reset();
    $('#add-modal').classList.add('hidden');
    await refresh();
    toast('Job saved');
  } catch (err) { toast(err.message, true); }
});

// ---------- drawer ----------

function closeDrawer() {
  CURRENT = null;
  $('#drawer').classList.add('hidden');
  $('#drawer-backdrop').classList.add('hidden');
}
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

async function openDrawer(id) {
  try {
    const { job } = await api(`/api/jobs/${id}`);
    fillDrawer(job);
    $('#drawer').classList.remove('hidden');
    $('#drawer-backdrop').classList.remove('hidden');
    selectTab('overview');
    // lazy-load JD + docs
    $('#d-jd').value = (await api(`/api/jobs/${job.id}/jd`)).content;
    for (const type of ['resume', 'cover-letter']) {
      const pane = $(`#tab-${type === 'resume' ? 'resume' : 'cover-letter'}`);
      $('.doc-editor', pane).value = (await api(`/api/jobs/${job.id}/documents/${type}`)).content;
    }
  } catch (err) { toast(err.message, true); }
}

function fillDrawer(job) {
  CURRENT = job;
  $('#d-role').textContent = job.role;
  $('#d-company').textContent = job.company;

  const chips = [];
  if (job.source) chips.push(`<span class="badge src">${esc(job.source)}</span>`);
  if (job.location) chips.push(`<span class="badge">${esc(job.location)}</span>`);
  if (job.salary) chips.push(`<span class="badge">${esc(job.salary)}</span>`);
  if (job.score > 0) chips.push(`<span class="badge score">★ ${job.score.toFixed(1)}/5</span>`);
  if (job.trackerStatus) chips.push(`<span class="badge">tracker: ${esc(job.trackerStatus)}</span>`);
  $('#d-meta').innerHTML = chips.join('');

  // stage buttons
  const wrap = $('#d-stages');
  wrap.innerHTML = '';
  for (const stage of STAGES) {
    const btn = document.createElement('button');
    btn.className = 'stagebtn' + (job.stage === stage.id ? ' active' : '');
    btn.textContent = stage.id === 'interview' && job.stage === 'interview' && job.round > 0
      ? `Interview · R${job.round}` : stage.label;
    btn.addEventListener('click', async () => {
      try {
        const round = stage.id === 'interview' ? Math.max(job.round, 1) : 0;
        const { job: updated } = await api(`/api/jobs/${job.id}/stage`, { method: 'POST', body: { stage: stage.id, round } });
        fillDrawer(updated);
        await refresh();
        toast(`Stage → ${stage.label}`);
      } catch (err) { toast(err.message, true); }
    });
    wrap.appendChild(btn);
  }
  $('#d-round-row').classList.toggle('hidden', job.stage !== 'interview');
  $('#d-round').value = Math.max(job.round, 1);

  // overview form
  const form = $('#d-form');
  for (const key of ['company', 'role', 'url', 'source', 'location', 'salary']) {
    form.elements[key].value = job[key] || '';
  }
  $('#d-notes').value = job.notes || '';
  const link = $('#d-open-url');
  link.style.display = job.url ? '' : 'none';
  link.href = job.url || '#';
  $('#d-report').textContent = job.reportPath ? `Evaluation report: ${job.reportPath}` : '';

  // history
  const ul = $('#d-history');
  ul.innerHTML = '';
  const hist = [...(job.history || [])].reverse();
  if (!hist.length) ul.innerHTML = '<li class="muted">No history yet (job tracked via CLI).</li>';
  for (const h of hist) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="t-label">${esc(h.label)}</div>
      <div class="t-date">${new Date(h.date).toLocaleString()}</div>
      ${h.note ? `<div class="t-note">${esc(h.note)}</div>` : ''}`;
    ul.appendChild(li);
  }
}

$('#d-round-apply').addEventListener('click', async () => {
  if (!CURRENT) return;
  const round = parseInt($('#d-round').value, 10) || 1;
  try {
    const { job } = await api(`/api/jobs/${CURRENT.id}/stage`, { method: 'POST', body: { stage: 'interview', round } });
    fillDrawer(job);
    await refresh();
    toast(`Interview round set to ${round}`);
  } catch (err) { toast(err.message, true); }
});

$('#d-save').addEventListener('click', async () => {
  if (!CURRENT) return;
  const form = $('#d-form');
  const patch = {};
  for (const key of ['company', 'role', 'url', 'source', 'location', 'salary']) {
    patch[key] = form.elements[key].value;
  }
  patch.notes = $('#d-notes').value;
  try {
    const { job } = await api(`/api/jobs/${CURRENT.id}`, { method: 'PATCH', body: patch });
    fillDrawer(job);
    await refresh();
    toast('Saved');
  } catch (err) { toast(err.message, true); }
});

$('#d-delete').addEventListener('click', async () => {
  if (!CURRENT) return;
  if (!confirm(`Delete "${CURRENT.role}" at ${CURRENT.company}? This removes the web-app record, saved JD and tailored documents (the CLI tracker row is kept).`)) return;
  try {
    await api(`/api/jobs/${CURRENT.id}`, { method: 'DELETE' });
    closeDrawer();
    await refresh();
    toast('Deleted');
  } catch (err) { toast(err.message, true); }
});

$('#d-jd-save').addEventListener('click', async () => {
  if (!CURRENT) return;
  try {
    await api(`/api/jobs/${CURRENT.id}/jd`, { method: 'PUT', body: { content: $('#d-jd').value } });
    $('#d-jd-status').textContent = 'saved ✓';
    setTimeout(() => $('#d-jd-status').textContent = '', 2000);
    await refresh();
  } catch (err) { toast(err.message, true); }
});

// tabs
function selectTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpane').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}
$$('.tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));

// document panes (tailored resume / cover letter) built from template
for (const type of ['resume', 'cover-letter']) {
  const pane = $(`#tab-${type}`);
  pane.appendChild($('#doc-pane-template').content.cloneNode(true));
  const editor = $('.doc-editor', pane);
  const status = $('.save-status', pane);

  $('.act-save', pane).addEventListener('click', async () => {
    if (!CURRENT) return;
    try {
      await api(`/api/jobs/${CURRENT.id}/documents/${type}`, { method: 'PUT', body: { content: editor.value } });
      status.textContent = 'saved ✓';
      setTimeout(() => status.textContent = '', 2000);
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  $('.act-from-main', pane).addEventListener('click', async () => {
    if (!CURRENT) return;
    if (editor.value.trim() && !confirm('Replace current content with your main resume?')) return;
    try {
      const { content } = await api(`/api/jobs/${CURRENT.id}/documents/${type}/from-main`, { method: 'POST' });
      editor.value = content;
      toast('Copied from cv.md — now tailor it');
    } catch (err) { toast(err.message, true); }
  });

  $('.act-prompt', pane).addEventListener('click', async () => {
    if (!CURRENT) return;
    try {
      const { prompt } = await api(`/api/jobs/${CURRENT.id}/documents/${type}/prompt`, { method: 'POST' });
      await navigator.clipboard.writeText(prompt);
      toast('Tailoring prompt copied — paste it into Claude');
    } catch (err) { toast(err.message, true); }
  });

  $('.act-generate', pane).addEventListener('click', async () => {
    if (!CURRENT) return;
    const btn = $('.act-generate', pane);
    btn.disabled = true;
    btn.textContent = 'Generating… (may take a minute)';
    try {
      const { content } = await api(`/api/jobs/${CURRENT.id}/documents/${type}/generate`, { method: 'POST' });
      editor.value = content;
      toast('Generated — review before using');
      await refresh();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate with Claude';
    }
  });

  $('.act-download', pane).addEventListener('click', () => {
    if (!CURRENT) return;
    const blob = new Blob([editor.value], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${CURRENT.id}-${type}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ---------- resume view ----------

async function loadResume() {
  try {
    $('#resume-editor').value = (await api('/api/resume')).content;
  } catch (err) { toast(err.message, true); }
}

$('#resume-save').addEventListener('click', async () => {
  try {
    await api('/api/resume', { method: 'PUT', body: { content: $('#resume-editor').value } });
    $('#resume-status').textContent = 'saved ✓';
    setTimeout(() => $('#resume-status').textContent = '', 2000);
  } catch (err) { toast(err.message, true); }
});

// ---------- stats ----------

async function renderStats() {
  try {
    const s = await api('/api/stats');
    const cards = [
      ['Total jobs', s.total],
      ['Applications sent', s.applied],
      ['Response rate', `${s.responseRate}%`],
      ['Interview rate', `${s.interviewRate}%`],
      ['Offer rate', `${s.offerRate}%`],
    ];
    $('#stats-cards').innerHTML = cards.map(([lbl, val]) =>
      `<div class="statcard"><div class="big">${val}</div><div class="lbl">${lbl}</div></div>`).join('');

    const max = Math.max(1, ...Object.values(s.byStage));
    $('#funnel').innerHTML = STAGES.map(st => {
      const n = s.byStage[st.id] || 0;
      return `<div class="funnel-row">
        <div>${esc(st.label)}</div>
        <div class="funnel-bar"><div class="funnel-fill" style="width:${n / max * 100}%"></div></div>
        <div class="muted">${n}</div>
      </div>`;
    }).join('');
  } catch (err) { toast(err.message, true); }
}

// ---------- util ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---------- init ----------

(async function init() {
  try {
    STAGES = (await api('/api/meta')).stages;
    await refresh();
  } catch (err) { toast(err.message, true); }
})();
