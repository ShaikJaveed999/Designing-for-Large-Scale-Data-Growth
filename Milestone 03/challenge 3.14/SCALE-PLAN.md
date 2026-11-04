# TrackFlow Scale Plan

### 1. Growth Projections
The supplied workload is 50,000 active users × 200 events per user per day = 10 million events per day. At 365 days per year, `events` grows by 3.65 billion rows annually. Including the supplied 45 million starting rows, the projections are 3.695B, 7.345B, and 10.995B rows after 12, 24, and 36 months. At an illustrative 250 bytes per event including representative indexes, that is approximately 924 GB, 1.84 TB, and 2.75 TB; this is a planning estimate, not a measured table size.

The starter data does not specify session or feature-usage rates. Assuming one row per active user per day for each table gives 18.25M, 36.5M, and 54.75M new rows over the same periods. The 90-day active-event target approaches 900M rows (about 225 GB at the same illustrative footprint); older rows remain queryable in `events_archive`, so archive growth is additional retained storage, not eliminated data.

### 2. Three-Strategy Summary
**PostgreSQL partitioning:** `events` is range-partitioned by UTC `created_at` month. Schema setup creates the current and next two monthly partitions; the nightly maintenance job keeps the next three months available. PostgreSQL can prune partitions for date-bounded metrics and archival queries. Time partitions suit both time-range analytics and dropping/archiving old ranges better than `user_id` partitions, which scatter a date-wide workload across users. Monthly partitions keep each active unit manageable without the high partition count of daily partitions or the coarse maintenance and pruning of yearly partitions.

**Event archiving:** A nightly job archives rows older than 90 days in 1,000-row transactions. It locks candidate rows, inserts them into `events_archive` with a composite duplicate key, verifies exact row equality for conflicts, and deletes only verified rows in the same transaction. `GET /events/archive?user_id=...` provides a read path for archived records. Archiving bounds live rows in the hot active-event set and its indexes while retaining historical records separately. PostgreSQL vacuum is needed to make deleted disk space reusable; `DELETE` alone does not immediately reduce file size.

**Read replica routing:** All mutations use the primary pool. Read-only route queries use `REPLICA_DB_URL` when configured and otherwise fall back to the primary. A client needing read-after-write behavior can set `X-TrackFlow-Consistency: primary` on the follow-up GET; write responses themselves are returned from the primary.

### 3. Implementation Order
1. Establish the partitioned event schema and indexes first, creating future partitions and validating the query plan so new writes and date-range reads have a predictable target.
2. Deploy and observe the 90-day archive job next. Its insert/verify/delete transaction and idempotent key rely on the partitioned active table; run it initially against a controlled data set and monitor row counts and failures.
3. Configure and enable read replicas after the write paths and archive job are confirmed to use the primary. Validate replica connection, lag, and the explicit primary-consistency option before directing ordinary reads to the replica.

For an existing unpartitioned installation, first use `migrations/001_partition_events.sql` during a maintenance window. It takes an exclusive table lock and copies rows in one transaction; rehearse it against a production-sized copy and provision disk for both old and new copies before cutover.

### 4. Trade-offs and Risks
Partitioning adds monthly DDL, partition-boundary, index, migration, and backup/restore complexity. The application cannot rely on a global unique constraint on `id` alone across partitions; the schema uses `(id, created_at)` as the primary key and a database identity sequence for generated IDs. Keep future partitions provisioned, monitor for missing bounds, and confirm pruning with `EXPLAIN`.

The archive endpoint is historical, while the active event endpoint reads only `events`. A replica may lag the primary, so recently archived rows can briefly be missing from an archive read; use the primary-consistency header when an immediate result is required. The archive job uses the primary and must not run with a read-only replica URL. Row locks and short batches permit retries, but a conflicting archive row with different contents intentionally fails and leaves the active row intact for investigation.

Replica routing reduces read load but introduces replication lag, another pool to monitor, additional connection use, and failover/configuration risk. The implementation falls back to primary only when no replica URL is configured; it does not silently retry a failing replica on the primary. Add an explicit operational failover policy and monitor p95 query latency, replica lag, WAL retention, partition count/size, archive throughput, and disk growth. The nightly Render cron manifest requires manual database URL configuration and a PostgreSQL role permitted to create future partitions.
