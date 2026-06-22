-- Funnel entity-step index (story-004, concern 18d098756f5a).
--
-- The funnel query (REQUIREMENTS.md §5.4) walks each entity through an ordered
-- step sequence inside a recursive CTE. Every recursive hop looks up the next
-- step with:
--   COALESCE(user_id, visitor_token) = entity   -- the entity equality
--   AND event_type = <next step>                -- the step type
--   AND timestamp > prev_step AND timestamp <= deadline  -- the time range
--
-- No existing index covers COALESCE(user_id, visitor_token): idx_beacon_events_user
-- and idx_beacon_events_visitor are on the raw columns, so the planner can't use
-- them for the COALESCE expression. Without this index each hop degrades to a
-- filter-scan over every step-typed event in the window. This partial expression
-- index leads on the COALESCE entity expression, then event_type, then timestamp,
-- making each hop a true index seek. Partial WHERE ... IS NOT NULL mirrors the
-- existing partial user/visitor indexes and matches the funnel's entity-not-null
-- predicate (rows with neither id can't be tracked and never enter the funnel).
CREATE INDEX idx_beacon_events_entity_step
    ON beacon_events (COALESCE(user_id, visitor_token), event_type, timestamp DESC)
    WHERE COALESCE(user_id, visitor_token) IS NOT NULL;
