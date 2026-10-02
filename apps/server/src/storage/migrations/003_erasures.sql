CREATE TABLE IF NOT EXISTS beacon_erasures (
    user_id_hash TEXT NOT NULL,
    count BIGINT NOT NULL,
    erased_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
