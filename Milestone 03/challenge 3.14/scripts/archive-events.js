const db = require('../db');

const RETENTION_DAYS = 90;
const DEFAULT_BATCH_SIZE = 1000;

const ARCHIVE_BATCH_SQL = `
  WITH candidates AS MATERIALIZED (
    SELECT id, user_id, session_id, event_type, properties, created_at
    FROM events
    WHERE created_at < $1
    ORDER BY created_at, id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  ),
  inserted AS (
    INSERT INTO events_archive
      (id, user_id, session_id, event_type, properties, created_at)
    SELECT id, user_id, session_id, event_type, properties, created_at
    FROM candidates
    ON CONFLICT (id, created_at) DO NOTHING
    RETURNING id, created_at
  ),
  already_archived AS (
    SELECT c.id, c.created_at
    FROM candidates c
    JOIN events_archive a
      ON a.id = c.id
     AND a.created_at = c.created_at
     AND a.user_id IS NOT DISTINCT FROM c.user_id
     AND a.session_id IS NOT DISTINCT FROM c.session_id
     AND a.event_type IS NOT DISTINCT FROM c.event_type
     AND a.properties IS NOT DISTINCT FROM c.properties
  ),
  verified AS (
    SELECT id, created_at FROM inserted
    UNION
    SELECT id, created_at FROM already_archived
  ),
  deleted AS (
    DELETE FROM events e
    USING verified v
    WHERE e.id = v.id AND e.created_at = v.created_at
    RETURNING e.id
  )
  SELECT
    (SELECT COUNT(*) FROM candidates)::INTEGER AS candidate_count,
    (SELECT COUNT(*) FROM deleted)::INTEGER AS archived_count
`;

async function archiveBatch(pool, cutoff, batchSize) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(ARCHIVE_BATCH_SQL, [cutoff, batchSize]);
    const { candidate_count: candidates, archived_count: archived } = result.rows[0];

    if (candidates !== archived) {
      throw new Error(
        `Archive batch verified ${archived} of ${candidates} selected events; no rows were deleted`
      );
    }

    await client.query('COMMIT');
    return archived;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Archive batch failed and its transaction could not be rolled back'
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function archiveOldEvents({
  pool = db.primaryPool,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive safe integer');
  }

  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let totalArchived = 0;

  while (true) {
    const archived = await archiveBatch(pool, cutoff, batchSize);
    totalArchived += archived;

    if (archived < batchSize) {
      return totalArchived;
    }
  }
}

module.exports = { archiveOldEvents, archiveBatch, ARCHIVE_BATCH_SQL };
