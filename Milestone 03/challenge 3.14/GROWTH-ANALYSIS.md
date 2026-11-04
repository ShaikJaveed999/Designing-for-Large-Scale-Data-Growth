# TrackFlow Database Growth Analysis

## A. Growth assumptions

The assignment workload is **50,000 users × 200 events per user per day = 10,000,000 events/day**. The projections use 365 days per year and a constant event rate. The supplied starter README reports 45,000,000 current `events` rows, described as about 4.5 days of data. Therefore:

| Elapsed time | New events | Total events, including 45M starting rows |
|---|---:|---:|
| 12 months (365 days) | 3,650,000,000 | 3,695,000,000 |
| 24 months (730 days) | 7,300,000,000 | 7,345,000,000 |
| 36 months (1,095 days) | 10,950,000,000 | 10,995,000,000 |

These are row counts, not measured database sizes. For planning only, this analysis assumes an average **250 bytes per active event row including representative indexes**, **250 bytes per archived event row including representative indexes**, **120 bytes per `feature_usage` row**, and **80 bytes per `sessions` row**. JSONB payload size, index choices, alignment, fill factor, compression, and vacuum state can change all these values; WAL, backups, replicas, and free space are excluded.

The archive is assumed to begin empty at rollout, and the archive job retains events older than 90 days. At steady state this leaves about **900,000,000 active events** (`10,000,000 × 90`) and moves older events to `events_archive`. Because the starter's 45M rows represent only 4.5 days, they fit inside the initial 90-day active window. After 12/24/36 months, approximately 2.795B/6.445B/10.095B rows are archived and 900M remain active. This assumes the nightly job keeps pace with ingestion and no events are removed from retention.

## B. Three largest tables in the actual schema

The actual tables are defined in `schema.sql`: `users`, `sessions`, partitioned `events`, `events_archive`, and `feature_usage`. With retention and the specified event rate, `events_archive` has the most rows after the 90-day warm-up; active `events` is bounded near 900M rows. The third-largest table cannot be determined precisely without session and feature-usage traffic. The planning comparison below assumes 50,000 new rows/day for each, as an explicit proxy rather than an observed rate. Under the assumed row footprints, `feature_usage` is slightly larger than `sessions`. The archive table is created empty at rollout; the figures below are rows accumulated since rollout, not initial archive history.

| Table | Purpose and current structure | Estimated growth | 12-month projection | 24-month projection | 36-month projection | Approximate storage implications |
|---|---|---|---:|---:|---:|---|
| `events_archive` | Retained raw events older than 90 days. Ordinary table; composite primary key `(id, created_at)` and indexes on `(user_id, created_at DESC)` and `created_at`; see `schema.sql`. | After day 90, roughly 10M rows/day, assuming the nightly archive keeps pace. | 2.795B rows | 6.445B rows | 10.095B rows | About 699 GB / 1.61 TB / 2.52 TB at the illustrative 250 bytes/row. |
| `events` | Current raw events, range-partitioned by UTC `created_at` month; composite primary key `(id, created_at)` and user/time and time indexes; see `schema.sql`. | 10M rows/day arrive; archive removes rows older than 90 days. | About 900M active rows | About 900M active rows | About 900M active rows | About 225 GB at the illustrative 250 bytes/row, excluding transient archive backlog and operational overhead. |
| `feature_usage`* | Feature interactions; `BIGSERIAL` primary key, user ID, feature name, timestamp, and count; see `schema.sql`. | Planning proxy: 50,000 rows/day, not specified by the assignment. | 18.25M rows | 36.50M rows | 54.75M rows | About 2.19 GB / 4.38 GB / 6.57 GB at the illustrative 120 bytes/row. |

`*` If sessions are created more often or the application's usage rate differs from the proxy, `sessions` may instead be the third-largest table. At the same illustrative 50,000 rows/day, `sessions` reaches 18.25M/36.50M/54.75M rows and about 1.46/2.92/4.38 GB. `users` has 50,000 rows under the scenario and is not one of the three largest by row count. The total event data across active and archived tables is still 3.695B/7.345B/10.995B rows at those dates. Archiving changes the active/archive split; it does not reduce retained raw-event count.

## C. Scalability risks and query evidence

No production PostgreSQL instance or representative-scale data set is configured in this workspace. Therefore **none of the 500 ms thresholds below is a measured latency or benchmark result**. Each is a cautious planning estimate, not a guarantee. Actual latency depends on PostgreSQL version, hardware, cache, storage, concurrent load, row/payload sizes, vacuum, and query plan.

1. **Monthly metrics aggregate — table: `events`; file/route: `routes/metrics.js`, `GET /metrics/monthly`. Exact application SQL:**

   ```sql
   SELECT COUNT(*), event_type
   FROM events
   WHERE created_at > NOW() - INTERVAL '30 days'
     AND created_at <= NOW()
   GROUP BY event_type
   ```

   At the stated rate, the qualifying month contains about **300M rows**. Even with partition pruning to the relevant monthly partitions, this query must inspect and aggregate all qualifying rows. A scan of 10M rows is already a useful test point; processing 300M rows on a general-purpose application database is a credible risk of exceeding 500 ms, but has not been measured here. **Estimate only; no observed threshold.** Benchmark at increasing row counts and use daily rollups or an analytics store if this request must remain interactive.

2. **Active-session listing — table: `sessions`; file/route: `routes/sessions.js`, `GET /sessions/active`. Exact SQL:**

   ```sql
   SELECT * FROM sessions WHERE ended_at IS NULL
   ```

   This returns every active session without pagination. The partial index `sessions_active_started_at_idx` can help find matches, but cannot eliminate the cost of transferring and JSON-serializing all result rows. Under the explicit proxy of 50,000 session rows/day, total session history reaches 18.25M/36.5M/54.75M rows; if a large fraction remain active, response size rather than a table scan can dominate. A response of **10,000 rows** is a useful first 500 ms load-test trigger, not a measured break point; actual active-session fraction is unknown. Paginate and monitor response size/latency.

3. **Active per-user event history — table: partitioned `events`; file/route: `routes/events.js`, `GET /events`. Exact SQL:**

   ```sql
   SELECT * FROM events
   WHERE user_id = $1
     AND created_at >= NOW() - INTERVAL '90 days'
   ORDER BY created_at DESC
   LIMIT 100
   ```

   The route bounds the search to active retention, and `(user_id, created_at DESC)` supports the filter/order; the timestamp range allows pruning old monthly partitions. These are controls, but an exceptionally high-volume user, cold cache, index bloat, or concurrent ingest can still raise latency. The workload average implies **18,000 events/user/90 days** if evenly distributed, but skew is unknown. **No defensible row-count threshold for 500 ms is measured.** Use 18,000 matching rows per user as the average-load benchmark point, then test skew (for example 10×/100×), `EXPLAIN (ANALYZE, BUFFERS)`, and p95/p99 latency.

4. **Nightly archive throughput/backlog — table: `events` and `events_archive`; file: `scripts/archive-events.js`, called by `scripts/maintenance.js` from the nightly cron. Exact selection SQL from `ARCHIVE_BATCH_SQL`:**

   ```sql
   SELECT id, user_id, session_id, event_type, properties, created_at
   FROM events
   WHERE created_at < $1
   ORDER BY created_at, id
   LIMIT $2
   FOR UPDATE SKIP LOCKED
   ```

   The batch defaults to 1,000 rows, inserts/compares archive records, and deletes verified rows within one transaction. With 10M old events arriving per day, it needs roughly **10,000 batches per nightly run** just to keep pace, in addition to handling backlog and concurrent writes. There is no benchmark proving the nightly window or query exceeds 500 ms. A useful operational warning threshold is a backlog that grows across successive runs or a batch p95 above the 500 ms target; both must be measured from job logs/metrics. Benchmark sustained batches at representative table/index sizes, increase batch size only after lock/WAL impact testing, and alert on archive lag.

## D. Reproducible benchmark procedure

Use a staging PostgreSQL database with the same PostgreSQL major version, indexes, partition layout, representative JSONB sizes, and hardware class as production. Do not populate production merely to create a benchmark. Load synthetic rows with realistic time distribution and user skew; record seed, data volume, hardware, cache state, and concurrent writer rate.

Run each exact route SQL and the archive candidate query at increasing row counts (for example 1M, 10M, 100M, then the largest staging capacity) with `EXPLAIN (ANALYZE, BUFFERS)`. `EXPLAIN ANALYZE` executes the query, so run archive mutations only inside a disposable staging transaction that is rolled back, or benchmark a read-only candidate-selection query. Capture planning/execution time and shared/local buffer hits/reads; separately measure API p50/p95/p99 under concurrency and response bytes. For partition pruning, inspect the plan's actual child scans for a bounded date predicate. Replace the planning estimates above only with reproducible measurements.

The integration suite also ran `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)` against the current-month time range in PGlite on 2026-11-04. The plan scanned only `events_2026_11` using its timestamp index (2 shared-buffer hits) and reported 1.539 ms planning / 0.146 ms execution on an empty test partition. This is evidence that the tested date predicate prunes other partitions in that embedded test engine; **it is not a production benchmark and says nothing about latency at millions of rows**.
