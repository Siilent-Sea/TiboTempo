-- Staging-edge stand-in heartbeat (STG-DRV). One row per scheduled run of the
-- stand-in fenced cron Worker; nothing else is stored.
CREATE TABLE staging_edge_heartbeat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_at_ms INTEGER NOT NULL,
  cron TEXT NOT NULL
);
