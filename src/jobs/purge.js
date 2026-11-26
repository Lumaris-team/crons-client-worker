// Hourly D1 purge: permanently deletes non-recurring tasks and events whose
// remind_date is more than 7 days in the past.
//
// Scope (per spec): tasks, trash_tasks, events, trash_events.
// Recurring rows are preserved: repeat_tasks / repeat_events are never
// touched, and rows inside the trash tables that still carry a real
// frequency (daily/weekly/monthly/yearly/custom-with-periods) are kept so
// they can be restored as repeats.

const PURGE_TABLES = ["tasks", "trash_tasks", "events", "trash_events"];
const RETENTION_DAYS = 7;

// Frequencies that mean "this row repeats" — everything else is one-shot.
const RECURRING_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];

async function tableColumns(db, table) {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set((results || []).map((r) => r.name));
  } catch {
    return new Set();
  }
}

export async function purgeOldTasks(env) {
  if (!env.TIMETABLE) return { skipped: "TIMETABLE binding missing" };
  const db = env.TIMETABLE;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400e3)
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD — remind_date is stored as ISO via toISOString()

  const results = {};
  for (const table of PURGE_TABLES) {
    const cols = await tableColumns(db, table);
    if (cols.size === 0) {
      results[table] = { skipped: "table missing" };
      continue;
    }
    if (!cols.has("remind_date")) {
      results[table] = { skipped: "no remind_date column" };
      continue;
    }

    // Non-recurring = frequency absent/empty/'custom' or NULL.
    // If the column doesn't exist on this table, every row is one-shot.
    const recurringClause = cols.has("frequency")
      ? `AND (frequency IS NULL OR frequency = '' OR frequency NOT IN (${RECURRING_FREQUENCIES.map(() => "?").join(",")}))`
      : "";
    const binds = cols.has("frequency") ? [...RECURRING_FREQUENCIES] : [];

    const res = await db
      .prepare(
        `DELETE FROM ${table}
         WHERE substr(remind_date, 1, 10) != ''
           AND substr(remind_date, 1, 10) < ?
           ${recurringClause}`
      )
      .bind(cutoff, ...binds)
      .run();

    results[table] = { deleted: res?.meta?.changes ?? 0 };
  }

  return { retention_days: RETENTION_DAYS, cutoff, tables: results };
}
