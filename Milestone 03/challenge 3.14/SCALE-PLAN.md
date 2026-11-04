# TrackFlow Scale Plan

## 1. Growth Projections

The actual schema in `schema.sql` has `users`, `sessions`, range-partitioned `events`, `events_archive`, and `feature_usage`. The assignment workload is `50,000 × 200 = 10,000,000` events/day, projected at a constant rate and 365 days/year. With the starter's 45M event rows, total raw events are 3.695B, 7.345B, and 10.995B after 12, 24, and 36 months.

The 90-day retention job aims to keep `events` near 900M rows (10M/day × 90 days). The archive accumulates approximately 2.795B, 6.445B, and 10.095B rows over those periods, assuming it begins empty and keeps up after the initial active window. At an illustrative 250 bytes per event including representative indexes, the respective event/archive storage estimates are about 225 GB active plus 699 GB archived at 12 months, 225 GB plus 1.61 TB at 24 months, and 225 GB plus 2.52 TB at 36 months. These are unmeasured planning values; they exclude operational overhead and vary with payload and index sizes.

The third-largest table after `events` and `events_archive` cannot be known from the scenario because session and feature-usage rates are not supplied. For comparison, a clearly labeled proxy of 50,000 rows/day for each gives 18.25M/36.5M/54.75M rows after 12/24/36 months; `feature_usage` is somewhat larger under the illustrative row-footprint assumptions. The full row-count table, schema description, and assumptions are in [GROWTH-ANALYSIS.md](./GROWTH-ANALYSIS.md).

## 2. Three-Strategy Summary

**PostgreSQL range partitioning.** `events` is partitioned by UTC `created_at` month. `ensure_event_partitions(3)` creates the current and next two months; the maintenance command calls it nightly. The date-bounded metrics and archival predicates allow PostgreSQL to prune irrelevant partitions. Monthly time partitions suit recent metrics and retention better than `user_id` partitions, which scatter a time-window query across users; they avoid both the high partition count of daily partitions and the coarse boundaries of yearly partitions. Partitioning controls active-table/index growth and makes time-based query and maintenance scope explicit, but it does not remove the need to aggregate all 300M rows in a 30-day metrics request.

**90-day event archiving.** `scripts/archive-events.js` selects rows older than 90 days in 1,000-row `FOR UPDATE SKIP LOCKED` batches. In one primary transaction it inserts into `events_archive`, prevents duplicates using `(id, created_at)`, verifies exact equality on conflict, and deletes only verified rows. Any mismatch rolls back. `GET /events/archive?user_id=...` exposes retained data. This bounds the hot active table near 900M rows when the job keeps pace, but the archive still grows by about 10M rows/day. Vacuum makes deleted space reusable; ordinary `DELETE` does not immediately shrink files.

**Read replica routing.** `db.js` sends all writes and maintenance to `PRIMARY_DB_URL`. Read-only API calls use `REPLICA_DB_URL` when present and otherwise fall back to the primary. Matching URLs share one pool for local development. Clients can request `X-TrackFlow-Consistency: primary` for read-after-write behavior. This reduces eligible read pressure on the primary; it does not fix a large aggregate, and a replica failure is surfaced rather than silently retried on primary.

## 3. Implementation Order

1. **Growth analysis:** establish row/storage assumptions, query risks, and a repeatable measurement baseline before schema changes.
2. **Database partitioning:** deploy monthly partitions and compatible indexes first; rehearse the existing-table migration, validate insert routing and partition pruning, and pre-create future partitions.
3. **Archiving:** enable the transactional 90-day archive after partitioning. Verify a controlled batch and duplicate/conflict handling before the nightly job; alert on growing backlog.
4. **Read replica routing:** configure primary and replica connections after write and maintenance paths are confirmed to use primary. Verify read traffic, consistency override, and lag.
5. **Testing:** run unit, route, migration, and real PostgreSQL-compatible integration tests at every change; stage representative data for `EXPLAIN (ANALYZE, BUFFERS)` and concurrency/load testing before production rollout.
6. **Deployment and monitoring:** deploy through the Render Blueprint only after supplying database URLs and reviewing migration downtime. Verify health and database-backed routes; monitor p95/p99 latency, partition creation, archive lag, replica lag, disk/WAL, backups, and recovery drills.

## 4. Trade-offs and Risks

Partitioning adds boundary management, per-partition indexes, migration, and backup/restore complexity. PostgreSQL uniqueness across partitions must include the partition key, hence `(id, created_at)` rather than a global `id` key; sequence-generated IDs remain used by the application. The existing migration takes an `ACCESS EXCLUSIVE` lock and copies rows in one transaction, so it needs a rehearsed maintenance window and disk headroom.

Archive endpoints read the archive table; a replica may not yet reflect a recent archival transaction. Send the primary-consistency header when an immediate read is needed. The composite archive key prevents duplicate records, while a conflicting row with different contents intentionally stops the batch and leaves the active source row intact for investigation. The scheduled job must run with write privileges on the primary and must keep pace with 10M old rows/day; a 1,000-row batch default implies about 10,000 batches per daily event volume.

Read replicas add connections, cost, monitoring, and replication-lag risk. The application falls back to primary only when no replica URL is configured; it deliberately does not mask replica outages. Operational controls should cover partition creation failures, archive backlog, replica lag, WAL and disk growth, table/index bloat, and nightly-job failures.

Backups must cover both the active partition tree and the unpartitioned archive, plus schema/functions and sequence state. Test point-in-time recovery and restore of both stores together; partition drops or archive cleanup must not be used as a substitute for verified backups. Deployment and database connectivity have not yet been verified in Render, so no production URL or production benchmark is claimed.
