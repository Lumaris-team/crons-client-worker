# crons-client-worker

Internal **cron worker** for Lumaris — no public URL (`workers_dev: false`),
reached only through Cloudflare Cron Triggers and service bindings.

## Triggers

| Cron          | Schedule      | Job                                                        |
|---------------|---------------|------------------------------------------------------------|
| `0 * * * *`   | hourly        | Homework diff + D1 purge                                   |
| `0 2 * * *`   | daily 02:00   | Trigger `update-client-account` via `UPDATER` binding      |

## Hourly jobs

### Homework watch (`src/jobs/homeworks.js`)

Fetches `GET /homeworks` (light mode) from `ed-client-worker` through the
`ED_CLIENT` service binding, flattens the ÉcoleDirecte `cahierdetexte`
payload, and diffs it against the `homeworks` table in the **`school_data`**
D1 database.

Each devoir is stored with a SHA-256 `signature` of its raw JSON:

- **new homework** → row inserted with `is_new = 1`
- **modified homework** (signature changed — content, done status, date…) →
  fields updated, `is_new = 1`, `last_changed` set
- **deleted homework** (vanished from ÉcoleDirecte) → `deleted = 1` **and**
  `is_new = 1` (the deletion indicator)
- **reappeared homework** → `deleted = 0`, `is_new = 1`

Flags stay `1` until acknowledged by a client — there is currently no ack
endpoint; the frontend will consume `is_new`/`deleted` when the homework UI
lands.

If ÉcoleDirecte answers `qcm_required` (2FA pending) or an empty list, the
run is skipped — an empty payload never wipes flags.

### D1 purge (`src/jobs/purge.js`)

Permanently deletes rows whose `remind_date` is **more than 7 days** in the
past, in the `timetable` D1 database:

- `tasks`, `trash_tasks`, `events`, `trash_events`
- `repeat_tasks` / `repeat_events` are **never** touched
- rows carrying a recurring `frequency` (`daily`/`weekly`/`monthly`/`yearly`)
  are preserved even inside the trash tables, so they can still be restored

## Daily job

At 02:00 the worker POSTs `/api/internal/update-workers` on
`update-client-account` through the `UPDATER` service binding. That endpoint
replies `202` immediately and runs the full worker redeploy in the
background (`ctx.waitUntil`), so the cron never blocks on deploy duration.

## Bindings (`wrangler.jsonc`)

| Binding      | Type     | Target                     |
|--------------|----------|----------------------------|
| `ED_CLIENT`  | service  | `ed-client-worker`         |
| `UPDATER`    | service  | `update-client-account`    |
| `TIMETABLE`  | d1       | `timetable`                |
| `SCHOOL_DATA`| d1       | `school_data`              |

D1 `database_id` placeholders (`__D1_ID_*__`) are resolved automatically by
`update-client-account` at deploy time — same convention as the other
workers.

## Manual run (debug)

Through a service binding only (no public URL):

```bash
# inside another worker on the same account:
env.CRONS_CLIENT_WORKER.fetch("https://crons-client-worker.internal/run?job=homeworks", { method: "POST" })
# job = homeworks | purge | update | all (default)
```

## Deployment

`crons-client-worker` is part of `update-client-account`'s `CONFIGURATION` — it is deployed
automatically, **after** `ed-client-worker`, `mega-client-worker`,
`authentication-client-worker` and `update-client-account` itself (its
service bindings must exist first).

Prerequisites on first deploy:

```bash
# school_data D1 must exist (created by the updater if missing) and the
# homeworks table is auto-created lazily — or apply explicitly:
wrangler d1 execute school_data --remote --file=./migrations/0001_create_homeworks.sql
```
