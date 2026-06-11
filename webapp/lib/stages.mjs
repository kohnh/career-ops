// Extended application stages used by the web app.
//
// The CLI tracker (data/applications.md) only knows the canonical states in
// templates/states.yml. The web app tracks finer-grained stages (OA, Round N)
// and maps each one onto a canonical state so both stay in sync: the detailed
// stage lives in data/webapp/jobs.json, the canonical projection lives in the
// tracker's Status column.

export const STAGES = [
  { id: 'saved',     label: 'Saved',      canonical: null },
  { id: 'applied',   label: 'Applied',    canonical: 'Applied' },
  { id: 'oa',        label: 'OA',         canonical: 'Responded' },
  { id: 'interview', label: 'Interview',  canonical: 'Interview' },
  { id: 'offer',     label: 'Offer',      canonical: 'Offer' },
  { id: 'rejected',  label: 'Rejected',   canonical: 'Rejected' },
  { id: 'closed',    label: 'Closed',     canonical: 'Discarded' },
];

const BY_ID = new Map(STAGES.map(s => [s.id, s]));

export function stageById(id) {
  return BY_ID.get(id) || null;
}

// Canonical tracker status for an extended stage. `null` means the job does
// not belong in the tracker yet (e.g. merely saved).
export function canonicalForStage(stageId) {
  const s = BY_ID.get(stageId);
  return s ? s.canonical : null;
}

// Map a canonical tracker status (or raw alias) back to a web-app stage, for
// tracker rows the web app has never seen. Evaluated rows surface in the
// Saved column: they exist but no application was sent yet.
export function stageForCanonical(rawStatus) {
  const s = String(rawStatus || '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase();

  if (/(no.?aplicar|^skip$|geo blocker|discarded|descartad|cerrada|cancelada|^dup|^duplicado|repost)/.test(s)) return 'closed';
  if (/(interview|entrevista)/.test(s)) return 'interview';
  if (/(offer|oferta)/.test(s)) return 'offer';
  if (/(responded|respondido)/.test(s)) return 'oa';
  if (/(applied|aplicad|enviada|^sent$)/.test(s)) return 'applied';
  if (/(rejected|rechazad)/.test(s)) return 'rejected';
  return 'saved'; // evaluated / hold / unknown → pre-application
}

// Human label for a stage record, e.g. "Round 2" for interview round 2.
export function stageLabel(stageId, round) {
  if (stageId === 'interview' && round > 0) return `Round ${round}`;
  const s = BY_ID.get(stageId);
  return s ? s.label : stageId;
}
