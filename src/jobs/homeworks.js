// Hourly homework watch: diffs the ÉcoleDirecte homework list against the
// `homeworks` table in the school_data D1 database and flags changes.
//
// Flags semantics (columns on `homeworks`):
//   is_new = 1  → the homework appeared, was modified, or reappeared
//   deleted  = 1 → the homework disappeared from ÉcoleDirecte
// Both are set together when a homework is deleted, so `is_new` alone means
// "something changed — look at it". Flags stay until acknowledged by the
// client (see POST /homeworks/ack on the main worker — TBD).

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS homeworks (
  id_devoir   TEXT PRIMARY KEY,
  date        TEXT,
  signature   TEXT NOT NULL,
  title       TEXT,
  subject     TEXT,
  done        INTEGER NOT NULL DEFAULT 0,
  is_new      INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  last_changed TEXT,
  raw         TEXT
)`;

let tableReady = false;
async function ensureTable(db) {
  if (tableReady) return;
  await db.prepare(TABLE_SQL).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_homeworks_deleted ON homeworks(deleted)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_homeworks_date ON homeworks(date)").run();
  tableReady = true;
}

// ---------- helpers ----------

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

async function signatureOf(devoir) {
  const data = new TextEncoder().encode(stableStringify(devoir ?? {}));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Flatten { data: { "YYYY-MM-DD": [devoir, ...] } } into a Map keyed by idDevoir.
function flattenHomeworks(payload) {
  const map = new Map();
  const data = payload?.data;
  if (!data || typeof data !== "object") return map;
  for (const [date, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    for (const devoir of list) {
      const id = devoir?.idDevoir ?? devoir?.id;
      if (id === null || id === undefined) continue;
      map.set(String(id), { devoir, date });
    }
  }
  return map;
}

// Defensive field extraction — ED devoir objects vary; raw JSON is kept anyway.
function extractFields(devoir) {
  const title =
    devoir?.titre ?? devoir?.intitule ?? devoir?.devoir ??
    devoir?.aFaire?.devoir ?? devoir?.matiere?.aFaire?.devoir ?? null;
  const subject =
    devoir?.matiere?.libelle ?? devoir?.matiere?.nom ?? devoir?.matiere ??
    devoir?.aFaire?.matiere?.libelle ?? null;
  const doneRaw = devoir?.fait ?? devoir?.effectue ?? devoir?.done ?? devoir?.aFaire?.fait ?? 0;
  return {
    title: typeof title === "string" ? title : title != null ? String(title) : null,
    subject: typeof subject === "string" ? subject : subject != null ? String(subject) : null,
    done: doneRaw ? 1 : 0,
  };
}

// ---------- main job ----------

export async function checkHomeworks(env) {
  if (!env.ED_CLIENT) return { skipped: "ED_CLIENT binding missing" };
  if (!env.SCHOOL_DATA) return { skipped: "SCHOOL_DATA binding missing" };

  const res = await env.ED_CLIENT.fetch("https://ed.internal/homeworks", {
    headers: { filter: "true" },
  });
  const payload = await res.json().catch(() => null);

  // QCM 2FA pending or ED error — skip this run, try again next hour.
  if (payload?.qcm_required) return { skipped: "qcm_required" };
  if (payload?.error) return { error: payload.error };

  const seen = flattenHomeworks(payload);
  // An empty payload must never wipe flags — ED sometimes returns partial data.
  if (seen.size === 0) return { skipped: "empty homework list" };

  const db = env.SCHOOL_DATA;
  await ensureTable(db);

  const { results: existingRows } = await db.prepare("SELECT * FROM homeworks").all();
  const existing = new Map((existingRows || []).map((r) => [String(r.id_devoir), r]));

  const now = new Date().toISOString();
  const statements = [];
  const stats = { inserted: 0, modified: 0, deleted: 0, restored: 0, unchanged: 0 };

  for (const [id, { devoir, date }] of seen) {
    const signature = await signatureOf(devoir);
    const fields = extractFields(devoir);
    const row = existing.get(id);

    if (!row) {
      statements.push(
        db.prepare(
          `INSERT INTO homeworks
             (id_devoir, date, signature, title, subject, done, is_new, deleted,
              first_seen, last_seen, last_changed, raw)
           VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`
        ).bind(id, date ?? null, signature, fields.title, fields.subject,
               fields.done, now, now, now, stableStringify(devoir))
      );
      stats.inserted++;
      continue;
    }

    const wasDeleted = Number(row.deleted) === 1;
    const changed = row.signature !== signature;

    if (changed || wasDeleted) {
      statements.push(
        db.prepare(
          `UPDATE homeworks SET
             date = ?, signature = ?, title = ?, subject = ?, done = ?,
             is_new = 1, deleted = 0, last_seen = ?, last_changed = ?, raw = ?
           WHERE id_devoir = ?`
        ).bind(date ?? null, signature, fields.title, fields.subject,
               fields.done, now, now, stableStringify(devoir), id)
      );
      if (wasDeleted) stats.restored++;
      else stats.modified++;
    } else {
      // Unchanged content — just refresh last_seen.
      statements.push(
        db.prepare("UPDATE homeworks SET last_seen = ? WHERE id_devoir = ?").bind(now, id)
      );
      stats.unchanged++;
    }
  }

  // Homeworks that vanished from ÉcoleDirecte → deletion indicator.
  for (const [id, row] of existing) {
    if (!seen.has(id) && Number(row.deleted) !== 1) {
      statements.push(
        db.prepare(
          "UPDATE homeworks SET is_new = 1, deleted = 1, last_changed = ? WHERE id_devoir = ?"
        ).bind(now, id)
      );
      stats.deleted++;
    }
  }

  // D1 batch limit is generous; chunk defensively anyway.
  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }

  return { ...stats, total_seen: seen.size, total_known: existing.size };
}
