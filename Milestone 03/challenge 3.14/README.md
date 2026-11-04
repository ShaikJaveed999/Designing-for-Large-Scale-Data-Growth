# TrackFlow API

TrackFlow is an event-tracking and analytics API built with Express and PostgreSQL. It records user events, manages sessions and feature usage, reports event-type metrics, and keeps older raw events queryable through an archive. Its event store uses monthly PostgreSQL range partitions, and database reads can be routed to a read replica.

## Architecture and growth

The schema contains `users`, `sessions`, partitioned `events`, `events_archive`, and `feature_usage`. With 50,000 users × 200 events/day, the workload is 10 million events per day. Including the supplied 45 million starting rows and assuming a constant rate with 365 days/year, total raw events project to 3.695B, 7.345B, and 10.995B after 12, 24, and 36 months. After 90-day retention stabilizes, active events approach 900M rows while older events accumulate in the archive. Session and feature-usage projections require separate assumptions because their rates are not supplied. See [GROWTH-ANALYSIS.md](./GROWTH-ANALYSIS.md) for table-by-table estimates and unmeasured latency risks.

The architecture uses UTC monthly range partitioning for event-time pruning; a transactional nightly archive for events older than 90 days; and primary/replica routing for writes and eligible reads. The replica is eventually consistent, with a primary-read header for read-after-write cases. See [SCALE-PLAN.md](./SCALE-PLAN.md) for implementation order and operational trade-offs.

## Technologies

- Node.js 18 or later
- Express 4
- PostgreSQL 14 or later
- `pg` connection pools and `dotenv`

## Installation and database setup

1. Install Node.js and PostgreSQL, then create a database named `trackflow`.
2. From this project directory, install dependencies and configure the connection:

   ```sh
   npm install
   cp .env.example .env
   ```

   Edit `.env` and set `PRIMARY_DB_URL` to the PostgreSQL connection string for the primary database. The example contains a placeholder password; replace it locally and never commit `.env`.

3. For a new database, apply the schema:

   ```sh
   psql -v ON_ERROR_STOP=1 -d trackflow -f schema.sql
   ```

   This creates the current and next two UTC monthly event partitions, the `events_archive` table, and supporting indexes. The database role used by the nightly maintenance job must be able to create partitions.

   For an existing installation with the original unpartitioned `events` table, take a backup and follow the maintenance-window procedure in `migrations/001_partition_events.sql`. It takes an `ACCESS EXCLUSIVE` lock and copies all existing events in one transaction; rehearse and size disk for the migration before production cutover.

4. Start the API:

   ```sh
   npm start
   ```

   The health endpoint is `GET /health`. It reports API process health, not database readiness.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PRIMARY_DB_URL` | Yes | PostgreSQL primary connection string. All writes and maintenance operations use this database. |
| `REPLICA_DB_URL` | No | Optional read-only PostgreSQL replica connection string. If omitted, reads use the primary. |
| `DATABASE_URL` | Legacy fallback | Used as the primary only when `PRIMARY_DB_URL` is unset. |
| `PORT` | No | HTTP port; defaults to `3000`. |

If the primary and replica URLs are identical, the application reuses the primary pool. For normal eventual-consistency reads, GET routes use the replica when configured. To read immediately after a write, send `X-TrackFlow-Consistency: primary` on the follow-up GET. Write responses themselves come from the primary and include that response header. The app does not silently fail over from an unavailable replica to the primary.

## API

| Method and route | Description |
|---|---|
| `POST /events` | Insert an event; writes to primary. |
| `GET /events?user_id={id}` | Return up to 100 newest active events for a user. |
| `GET /events/archive?user_id={id}` | Return up to 100 newest archived events for a user. |
| `POST /sessions/start` | Start a session; writes to primary. |
| `GET /sessions/active` | List active sessions. |
| `GET /metrics/monthly` | Aggregate event types over the previous 30 days. |
| `POST /metrics/feature-usage` | Record feature usage; writes to primary. |
| `GET /health` | Report API process health. |

Example read-after-write request:

```http
GET /events?user_id=42
X-TrackFlow-Consistency: primary
```

## Partitioning and archiving

`events` is partitioned by range on its non-null `created_at` timestamp. `ensure_event_partitions(3)` creates the current UTC month and the next two months. The metrics query includes a date range that PostgreSQL can prune. The active event-history route includes the 90-day retention bound and uses a `(user_id, created_at DESC)` partitioned index; the archive query filters by its cutoff.

Archiving is implemented in `scripts/archive-events.js`. Each 1,000-row batch runs in a primary-database transaction: select rows older than 90 days with `FOR UPDATE SKIP LOCKED`, insert into `events_archive` with `ON CONFLICT DO NOTHING`, verify that any existing archive row exactly matches the source, and delete only verified active rows. If verification or deletion fails, the transaction rolls back. The archive table has a composite primary key and user/time indexes; use `/events/archive` to retrieve retained records. Archiving lowers live rows and index entries in the active table; PostgreSQL vacuum makes deleted space reusable, but ordinary `DELETE` does not immediately shrink files on disk.

The root `render.yaml` configures a Render web service and a nightly maintenance cron job at 02:00 UTC. The job ensures future monthly partitions exist and runs archival. Production database URLs and deployment approval must be configured manually in Render.

## Tests

Run the automated test suite with:

```sh
npm test
```

The tests exercise read/write pool routing, primary fallback and same-URL behavior, route-level consistency selection, archive transaction handling, and schema/deployment configuration contracts. The latest run reported **17 passed, 0 failed**. Embedded PostgreSQL (PGlite) integration tests execute the schema and migration, verify partition pruning and event insertion, exercise API event creation/read, and test archival rollback and duplicate handling. PGlite is for automated testing; its empty-partition plan timings are not production benchmarks. Production still requires PostgreSQL 14 or later.

## Scale documentation

- [GROWTH-ANALYSIS.md](./GROWTH-ANALYSIS.md) — workload assumptions, 12/24/36-month projections, existing query risks, and estimates.
- [SCALE-PLAN.md](./SCALE-PLAN.md) — strategy summary, implementation order, and operational trade-offs.
- [VIDEO-WALKTHROUGH-SCRIPT.md](./VIDEO-WALKTHROUGH-SCRIPT.md) — 2–3 minute recording script. No video has been recorded or uploaded.

## Deployment

No deployment has been completed, so there is no verified deployment URL. To deploy with Render, use the root `render.yaml`, create/configure a PostgreSQL primary (and optional replica), set `PRIMARY_DB_URL` and `REPLICA_DB_URL` in the web and cron services, apply `schema.sql` or the migration as appropriate, and verify `/health` and database-backed routes before publishing a URL.
