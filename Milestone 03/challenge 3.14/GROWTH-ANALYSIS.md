# TrackFlow Database Growth Analysis

## Workload and assumptions

The supplied README states 50,000 active users, 200 events per user per day, 10,000,000 new events per day, and 45,000,000 existing event rows. The event rate is therefore 10,000,000 rows/day, or about 116 rows/second averaged across a day. Peaks may be much higher; no peak-rate data was supplied.

Projections below use 365 days per year and assume that the stated event rate remains constant. Event totals include the supplied 45,000,000-row starting point. The starter schema does not give starting counts or growth rates for `sessions` and `feature_usage`; for comparison only, their estimates assume one new session and one feature-usage row per active user per day (50,000 rows/day) and exclude unknown starting counts. Actual feature usage may be higher or lower.

For rough capacity planning only, estimated stored footprints are 250 bytes/event (row, average JSONB payload, and representative indexes), 80 bytes/session, and 120 bytes/feature-usage row. These are assumptions, not measurements or benchmark results. They exclude WAL, free space, replicas, backups, and operational overhead. Actual JSONB sizes, indexes, fill factor, and PostgreSQL version will change the results.

## Row-count projections

| Table | Planning assumption | 12 months | 24 months | 36 months |
|---|---|---:|---:|---:|
| `events` | 45M existing + 10M/day | 3.695B rows | 7.345B rows | 10.995B rows |
| `sessions` | 50,000 new rows/day; starting count unknown | 18.25M new rows | 36.50M new rows | 54.75M new rows |
| `feature_usage` | 50,000 new rows/day; starting count unknown | 18.25M new rows | 36.50M new rows | 54.75M new rows |

Calculations:

- Events: `45,000,000 + (10,000,000 × 365 × years)`.
- Sessions and feature usage: `50,000 × 365 × years`, plus any existing rows not provided.
- With a 90-day active-event retention target, the active event set approaches `10,000,000 × 90 = 900,000,000` rows. Older rows move to the archive; archiving changes the active-table size, not the total retained event count.

At the assumed footprints, event storage alone is approximately 924 GB, 1.84 TB, and 2.75 TB after 12, 24, and 36 months, respectively. The corresponding estimated session footprints are 1.46 GB, 2.92 GB, and 4.38 GB; feature-usage footprints are also 2.19 GB, 4.38 GB, and 6.57 GB. These decimal-unit estimates are directional only. At steady state, 900M active events would occupy roughly 225 GB under the same event-footprint assumption, before operational overhead.

## Existing queries and scalability risks

The estimates below are not benchmark results. No production-like PostgreSQL instance, representative data set, or hardware benchmark is available in this workspace. The 500 ms thresholds are planning triggers and depend on storage, cache state, indexes, concurrency, row width, and query plans.

1. **User event history — `routes/events.js`, `GET /events`, `SELECT * FROM events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`.** The schema defines no index on `events.user_id` or `(user_id, created_at)`, and this query has no date predicate. On the current heap schema, an unindexed lookup may exceed 500 ms once it must scan roughly 5–10M event rows (about 0.5–1 day at the stated rate); this is a coarse estimate. After partitioning, the missing time bound also prevents pruning older partitions. Add a partition-compatible `(user_id, created_at DESC)` index and, if the product's “recent” contract allows it, a bounded time predicate; preserve the intended retention and history behavior.

2. **Monthly metrics — `routes/metrics.js`, `GET /metrics/monthly`, `SELECT COUNT(*), event_type FROM events WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY event_type`.** The query must read and aggregate up to 300M recent rows at the stated rate. A scan/aggregate over even approximately 10M qualifying rows can exceed 500 ms on ordinary shared database hardware; this is an estimate, not a measured threshold. A date predicate helps partition pruning, but does not avoid reading qualifying rows. Consider daily rollups/materialized aggregates or an analytics store, and validate with `EXPLAIN (ANALYZE, BUFFERS)` on representative data.

3. **Active sessions — `routes/sessions.js`, `GET /sessions/active`, `SELECT * FROM sessions WHERE ended_at IS NULL`.** There is no partial index for active rows, no pagination, and the route serializes every matching session. A full scan can become material around 1–5M session rows, while a response containing hundreds of thousands of active sessions can itself exceed 500 ms much earlier. Add a partial index such as `ON sessions (started_at) WHERE ended_at IS NULL`, paginate the API, and ensure sessions are closed by the application.

4. **Unbounded event-table growth and maintenance — `schema.sql`, `events` table; inserts in `routes/events.js`, `POST /events`.** The flat table grows by 300M rows per 30 days and is about 3.7B rows after the first year under the projection. As a planning warning, scans and maintenance touching tens to hundreds of millions of rows (roughly 10–30 days of arrivals) may exceed 500 ms and increase vacuum, index, backup, and recovery costs; the exact point must be measured. Range partition by event time, retain bounded active partitions, archive old data, and load-test sustained and burst ingestion.

## Measurement plan

Before production sizing, load representative event payloads and indexes; measure insert throughput and p50/p95/p99 latency under expected concurrency; run each route query with `EXPLAIN (ANALYZE, BUFFERS)` at increasing row counts; and record table/index sizes, WAL volume, vacuum duration, and replica lag. Replace the illustrative footprints and latency thresholds above with those measured results.
