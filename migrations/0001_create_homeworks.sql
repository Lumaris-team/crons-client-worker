-- Migration: homeworks change-tracking table
-- Target database: school_data (D1)
-- Applied by: wrangler d1 execute school_data --remote --file=./migrations/0001_create_homeworks.sql
-- (crois also self-creates this table lazily via CREATE TABLE IF NOT EXISTS —
--  this file is kept for explicit/remote provisioning and documentation.)

CREATE TABLE IF NOT EXISTS homeworks (
  id_devoir    TEXT PRIMARY KEY,          -- ÉcoleDirecte idDevoir
  date         TEXT,                      -- échéance key from cahierdetexte (YYYY-MM-DD)
  signature    TEXT NOT NULL,             -- sha256 of the raw devoir JSON (change detection)
  title        TEXT,
  subject      TEXT,
  done         INTEGER NOT NULL DEFAULT 0,
  is_new       INTEGER NOT NULL DEFAULT 0,-- 1 = new / modified / reappeared / deleted
  deleted      INTEGER NOT NULL DEFAULT 0,-- 1 = disappeared from ÉcoleDirecte
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  last_changed TEXT,
  raw          TEXT                       -- full devoir JSON snapshot
);

CREATE INDEX IF NOT EXISTS idx_homeworks_deleted ON homeworks(deleted);
CREATE INDEX IF NOT EXISTS idx_homeworks_date ON homeworks(date);
