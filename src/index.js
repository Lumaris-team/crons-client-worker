import { checkHomeworks } from "./jobs/homeworks.js";
import { purgeOldTasks } from "./jobs/purge.js";
import { resetRecurringTasks } from "./jobs/recurrence.js";

// crons-client-worker — internal cron worker for Lumaris.
//
// This worker is NOT meant to be reached from the public internet
// (workers_dev: false). It runs entirely on Cloudflare Cron Triggers:
//
//   "0 * * * *"  hourly  → homework change detection + D1 purge
//   "0 2 * * *"  daily   → trigger update-client-account via service binding
//
// Service bindings used:
//   ED_CLIENT  → ed-client-worker      (ÉcoleDirecte homework list)
//   UPDATER    → update-client-account (worker redeploy trigger)
//   TIMETABLE  → D1 "timetable"        (tasks / events purge)
//   SCHOOL_DATA→ D1 "school_data"      (homeworks table)

const CRON_HOURLY = "0 * * * *";
const CRON_DAILY = "0 2 * * *";

async function runHourlyJobs(env) {
  const [homeworks, purge] = await Promise.allSettled([
    checkHomeworks(env),
    purgeOldTasks(env),
  ]);
  return {
    homeworks: homeworks.status === "fulfilled" ? homeworks.value : { error: homeworks.reason?.message },
    purge: purge.status === "fulfilled" ? purge.value : { error: purge.reason?.message },
  };
}

async function runDailyJobs(env) {
  // Recurring reset must run BEFORE the updater trigger so a redeploy of
  // this very worker can't kill it mid-flight.
  let recurrence = null;
  try {
    recurrence = await resetRecurringTasks(env);
  } catch (e) {
    recurrence = { error: e?.message || "recurrence reset failed" };
  }

  // Fire-and-forget trigger: the updater answers 202 immediately and keeps
  // deploying in the background via ctx.waitUntil on its side.
  let updater;
  try {
    const res = await env.UPDATER.fetch("https://updater.internal/api/internal/update-workers", {
      method: "POST",
    });
    updater = { status: res.status };
  } catch (e) {
    updater = { error: e?.message || "updater trigger failed" };
  }
  return { recurrence, updater };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check — only reachable through bindings / wrangler dev.
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, worker: "crons-client-worker" });
    }

    // Manual trigger for debugging (internal binding calls only).
    if (url.pathname === "/run" && request.method === "POST") {
      const which = url.searchParams.get("job") || "all";
      try {
        let result;
        if (which === "homeworks") result = await checkHomeworks(env);
        else if (which === "purge") result = await purgeOldTasks(env);
        else if (which === "update") result = await runDailyJobs(env);
        else result = { hourly: await runHourlyJobs(env), daily: await runDailyJobs(env) };
        return Response.json({ ok: true, result });
      } catch (e) {
        return Response.json({ ok: false, error: e?.message }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (event.cron === CRON_DAILY) {
          const result = await runDailyJobs(env);
          console.log("[crons-client-worker] daily updater trigger:", JSON.stringify(result));
          return;
        }
        const result = await runHourlyJobs(env);
        console.log(`[crons-client-worker] hourly (${event.cron}):`, JSON.stringify(result));
      })().catch((e) => {
        console.error("[crons-client-worker] scheduled error:", e?.stack || e);
        throw e;
      })
    );
  },
};
