// Page-level state tracking for AI grounding: what the agent already
// accomplished, where the viewport is, what the form contains, and what
// changed since the last read.  The store is intentionally process-local
// (survives a single content-script session) and bounded: form values are
// capped so a 200-field checkout does not flood the model's context.
const FORM_VALUE_LIMIT = 40;     // fields reported before truncation
const FORM_TEXT_LIMIT = 120;     // characters per value
const HISTORY_LIMIT = 20;        // actions retained for progress reporting
const HISTORY_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function cap(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createPageStateStore() {
  let lastSnapshotAt = 0;
  let lastSnapshotRevision = 0;
  let lastSnapshotUrl = '';
  let lastSnapshotControlCount = 0;
  let scroll = { x: 0, y: 0 };
  const forms = new Map();  // form id -> { fields, capturedAt }
  const history = [];

  return {
    get lastSnapshotAt() { return lastSnapshotAt; },
    get lastSnapshotRevision() { return lastSnapshotRevision; },
    get lastSnapshotUrl() { return lastSnapshotUrl; },
    get scroll() { return { ...scroll }; },
    get history() { return history.map(entry => ({ ...entry })); },

    noteSnapshot({ url, revision, controlCount, title }) {
      lastSnapshotAt = Date.now();
      lastSnapshotUrl = typeof url === 'string' ? url : '';
      lastSnapshotRevision = Number(revision) || 0;
      lastSnapshotControlCount = Number(controlCount) || 0;
      if (title !== undefined) this.lastTitle = cap(title, 120);
    },

    noteScroll(x, y) {
      const nx = Number(x) || 0;
      const ny = Number(y) || 0;
      if (nx === scroll.x && ny === scroll.y) return;
      scroll = { x: nx, y: ny };
    },

    // Pull form values from a form element and store a bounded summary.
    captureForm(form, label) {
      if (!form || typeof form.querySelectorAll !== 'function') return null;
      const fields = [];
      let total = 0;
      for (const field of form.querySelectorAll('input, textarea, select')) {
        if (field.disabled || field.type === 'hidden' || field.type === 'submit' || field.type === 'button') continue;
        if (total >= FORM_VALUE_LIMIT) break;
        const name = field.name || field.id || field.tagName.toLowerCase();
        let value = field.value ?? '';
        if (field.type === 'checkbox' || field.type === 'radio') value = field.checked ? (value || 'on') : '';
        if (field.type === 'password') value = '[REDACTED]';
        if (value !== '') {
          fields.push({ name: cap(name, 40), value: cap(value, FORM_TEXT_LIMIT) });
          total += 1;
        }
      }
      const entry = { label: cap(label || 'form', 60), fields, capturedAt: Date.now() };
      forms.set(entry.label, entry);
      return entry;
    },

    getForms() {
      return [...forms.values()].map(entry => ({ ...entry }));
    },

    // Record a successful or failed action for progress reporting.
    recordAction(action, target, ok, detail) {
      const now = Date.now();
      const entry = {
        action: cap(action, 20),
        target: cap(target, 60),
        ok: Boolean(ok),
        at: now
      };
      if (detail !== undefined) entry.detail = cap(detail, 120);
      history.push(entry);
      while (history.length > HISTORY_LIMIT) history.shift();
      return entry;
    },

    // Everything an agent needs to know "where am I?" without re-snapshotting.
    summary() {
      const now = Date.now();
      const recent = history.filter(entry => now - entry.at <= HISTORY_MAX_AGE_MS);
      const successes = recent.filter(entry => entry.ok).length;
      const failures = recent.length - successes;
      return {
        lastSnapshotAt: lastSnapshotAt || null,
        lastSnapshotAgeMs: lastSnapshotAt ? now - lastSnapshotAt : null,
        lastSnapshotUrl: lastSnapshotUrl || null,
        lastSnapshotRevision: lastSnapshotRevision || null,
        controlCount: lastSnapshotControlCount || 0,
        scroll,
        forms: this.getForms(),
        progress: {
          actions: recent.length,
          successes,
          failures,
          lastAction: recent.length ? recent[recent.length - 1] : null
        }
      };
    }
  };
}