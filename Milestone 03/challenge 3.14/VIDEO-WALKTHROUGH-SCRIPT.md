# TrackFlow Video Walkthrough Script

**Target length:** about 2 minutes 40 seconds. This is a recording script only; no video has been recorded or uploaded.

## 0:00–0:20 – Introduction

“Hi, this is TrackFlow, an event tracking and analytics API built with Express and PostgreSQL. The challenge assumes 50,000 users, with 200 events per user each day. That is 10 million events per day, so we need to think about table growth, query performance, and operations from the start.”

## 0:20–0:50 – Schema and growth projections

“Here in `schema.sql`, the main tables are `events`, `events_archive`, `sessions`, and `feature_usage`. The active event table is partitioned by month, and old raw events move to the archive after 90 days. The analysis uses 365 days per year. Including the supplied 45 million starting rows, total events reach about 3.695 billion in 12 months, 7.345 billion in 24 months, and 10.995 billion in 36 months. The storage figures are clearly labeled estimates, not measured sizes.”

## 0:50–1:20 – Four scalability risks

“In `GROWTH-ANALYSIS.md`, the first risk is monthly metrics: it reads up to 300 million events for 30 days. Second, the active-session endpoint returns every active session without pagination. Third, user event history can be affected by user skew and index/cache pressure, even though it has a 90-day bound and a matching index. Fourth, the nightly archive must process around 10 million old events each day, or about 10,000 batches at the current batch size. The 500-millisecond thresholds are estimates or test triggers, not benchmark claims. The document includes a staging procedure for measuring them.”

## 1:20–2:10 – Three strategies and order

“First, the event table uses UTC monthly range partitions. The current month and next two are created, and the date filters let PostgreSQL prune partitions. Second, the archive job uses transactions, duplicate protection, and row comparison. It only deletes active rows when an archive copy is verified; archived history remains available through an API route. Third, writes go to the primary database. Reads can use the replica, and clients can request the primary for an immediate read after a write.

The plan begins with growth analysis, then partitioning, then archiving, then replica routing. Testing follows each step, and deployment comes only after database configuration and monitoring are ready.”

## 2:10–2:40 – Tests and conclusion

“The automated tests include embedded PostgreSQL checks for the schema, migration, partition routing and pruning, event API reads and writes, and safe archiving. The last run reported 17 passing tests and no failures. Here are `GROWTH-ANALYSIS.md` and `SCALE-PLAN.md`. Deployment is not verified yet, so I’m not showing a live URL. Thanks for watching.”
