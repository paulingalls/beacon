-- Beacon initial schema (REQUIREMENTS.md §4.1, §4.2). Verbatim — do not
-- substitute the abbreviated schema in CLAUDE.md, which is stale.

-- Core events table.
CREATE TABLE beacon_events (
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      TEXT NOT NULL,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- event time: when it happened (client clock)
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- ingest time: when the server stored it
    event_type      TEXT NOT NULL,
    user_id         TEXT,
    visitor_token   TEXT,
    platform        TEXT NOT NULL DEFAULT 'web',
    properties      JSONB NOT NULL DEFAULT '{}',
    context         JSONB NOT NULL DEFAULT '{}',
    attribution     JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_beacon_events_product_time ON beacon_events (product_id, timestamp DESC);
CREATE INDEX idx_beacon_events_user ON beacon_events (user_id, timestamp DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_beacon_events_visitor ON beacon_events (visitor_token) WHERE visitor_token IS NOT NULL;
CREATE INDEX idx_beacon_events_type ON beacon_events (product_id, event_type, timestamp DESC);

-- Short links table.
CREATE TABLE beacon_short_links (
    code            TEXT PRIMARY KEY,
    destination     TEXT NOT NULL,
    product_id      TEXT NOT NULL,
    campaign        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    click_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_beacon_short_links_product ON beacon_short_links (product_id);

-- Schema metadata (auto-populated, used by /analytics/schema).
CREATE TABLE beacon_meta (
    product_id      TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    count           BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, event_type)
);

-- Applied-migration ledger (idempotent — the runner also ensures this).
CREATE TABLE IF NOT EXISTS beacon_migrations (
    id          SERIAL PRIMARY KEY,
    filename    TEXT NOT NULL UNIQUE,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
