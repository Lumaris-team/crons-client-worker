// Daily recurrence reset: unchecks (is_done = 0) recurring tasks/events whose
// period ended yesterday — i.e. days that open a NEW occurrence.
//
// Runs ONCE per day (wired into the 02:00 cron, not the hourly one) so a
// task checked during the day is never re-unchecked by the next hourly run.
//
// Occurrence model (UTC dates — consistent with remind_date ISO storage):
//   daily   → every day is a new occurrence
//   weekly  → additional_data.recurrence.days[] (getUTCDay 0=dim), fallback:
//             the anchor's weekday
//   monthly → recurrence.dom, fallback: anchor's day-of-month
//   yearly  → recurrence.month + recurrence.day, fallback: anchor's date
//   custom  → never auto-unchecked (free-text schedule, no engine)
//
// Only rows with is_done = 1 are touched, and only on days that are actual
// occurrences on/after the anchor date.

const REPEAT_TABLES = ["repeat_tasks", "repeat_events"];

function parseRecurrence(row) {
  try {
    const ad = JSON.parse(row.additional_data || "{}");
    return ad?.recurrence && typeof ad.recurrence === "object" ? ad.recurrence : null;
  } catch {
    return null;
  }
}

function isOccurrenceDay(row, today) {
  const rec = parseRecurrence(row);
  const freq = rec?.freq || row.frequency || "custom";
  if (freq === "custom" || !freq) return false;

  const anchor = row.remind_date ? new Date(row.remind_date) : null;
  if (!anchor || isNaN(anchor)) return freq === "daily";

  const t = today.getTime();
  const a = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  if (t < a) return false; // occurrence before the anchor date — not started yet

  if (freq === "daily") return true;

  if (freq === "weekly") {
    const days = Array.isArray(rec?.days) && rec.days.length
      ? rec.days.map(Number)
      : [anchor.getUTCDay()];
    return days.includes(today.getUTCDay());
  }

  if (freq === "monthly") {
    const dom = rec?.dom || anchor.getUTCDate();
    return today.getUTCDate() === Math.min(dom, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate());
  }

  if (freq === "yearly") {
    const mo = rec?.month || anchor.getUTCMonth() + 1;
    const dy = rec?.day || anchor.getUTCDate();
    const dim = new Date(Date.UTC(today.getUTCFullYear(), mo, 0)).getUTCDate();
    return today.getUTCMonth() + 1 === mo && today.getUTCDate() === Math.min(dy, dim);
  }

  return false;
}

export async function resetRecurringTasks(env) {
  if (!env.TIMETABLE) return { skipped: "TIMETABLE binding missing" };
  const db = env.TIMETABLE;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const results = {};
  for (const table of REPEAT_TABLES) {
    let rows = [];
    try {
      const res = await db
        .prepare(`SELECT task_id, frequency, remind_date, additional_data, is_done FROM ${table} WHERE is_done = 1`)
        .all();
      rows = res?.results || [];
    } catch {
      results[table] = { skipped: "table missing" };
      continue;
    }

    let unchecked = 0;
    const stmts = [];
    for (const row of rows) {
      if (!isOccurrenceDay(row, today)) continue;
      stmts.push(
        db.prepare(`UPDATE ${table} SET is_done = 0 WHERE task_id = ?`).bind(Number(row.task_id))
      );
      unchecked++;
    }
    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }
    results[table] = { checked_done: rows.length, unchecked };
  }

  return { date: today.toISOString().slice(0, 10), tables: results };
}
