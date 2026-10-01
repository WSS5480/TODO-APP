-- The push scheduler's storage. Two tables, no history.
--
-- Everything here is disposable: a subscription the phone has thrown away is
-- deleted on the next failed send, and an alarm is forgotten once it has rung.
-- Nothing is kept that would be worth stealing — the titles of upcoming tasks
-- are the only content, and they have to be here for the notification to say
-- anything useful.

CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alarms (
  endpoint TEXT NOT NULL,
  id       TEXT NOT NULL,
  title    TEXT NOT NULL,
  kind     TEXT NOT NULL,           -- 'due' | 'soon'
  at       INTEGER NOT NULL,        -- ms since the epoch
  sent_at  INTEGER,                 -- NULL until it has rung
  PRIMARY KEY (endpoint, id)
);

-- The scheduler's only query: what is owed, oldest first.
CREATE INDEX IF NOT EXISTS alarms_pending ON alarms (at) WHERE sent_at IS NULL;
