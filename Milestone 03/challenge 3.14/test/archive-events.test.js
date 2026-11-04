const assert = require('node:assert/strict');
const test = require('node:test');

process.env.PRIMARY_DB_URL = 'postgresql://primary.example/trackflow';
const { archiveOldEvents, ARCHIVE_BATCH_SQL } = require('../scripts/archive-events');

function createPool(results) {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (text === ARCHIVE_BATCH_SQL) {
        return { rows: [results.shift()] };
      }
      return { rows: [] };
    },
    release() {
      calls.push({ text: 'RELEASE' });
    },
  };

  return {
    calls,
    async connect() {
      return client;
    },
  };
}

test('archives old rows in verified, committed batches', async () => {
  const pool = createPool([
    { candidate_count: 2, archived_count: 2 },
    { candidate_count: 0, archived_count: 0 },
  ]);
  const now = new Date('2026-11-04T00:00:00.000Z');

  const archived = await archiveOldEvents({ pool, now, batchSize: 2 });

  assert.equal(archived, 2);
  const batchCalls = pool.calls.filter((call) => call.text === ARCHIVE_BATCH_SQL);
  assert.equal(batchCalls.length, 2);
  assert.equal(batchCalls[0].params[0].toISOString(), '2026-08-06T00:00:00.000Z');
  assert.equal(batchCalls[0].params[1], 2);
  assert.equal(pool.calls.filter((call) => call.text === 'COMMIT').length, 2);
  assert.equal(pool.calls.some((call) => call.text === 'ROLLBACK'), false);
  assert.equal(pool.calls.filter((call) => call.text === 'RELEASE').length, 2);
});

test('rolls back a batch if an archive conflict is not verified', async () => {
  const pool = createPool([{ candidate_count: 1, archived_count: 0 }]);

  await assert.rejects(
    archiveOldEvents({ pool, now: new Date('2026-11-04T00:00:00.000Z'), batchSize: 10 }),
    /verified 0 of 1/
  );
  assert.equal(pool.calls.some((call) => call.text === 'COMMIT'), false);
  assert.equal(pool.calls.some((call) => call.text === 'ROLLBACK'), true);
  assert.equal(pool.calls.some((call) => call.text === 'RELEASE'), true);
});

test('uses duplicate protection, row locks, and deletes only verified rows', () => {
  assert.match(ARCHIVE_BATCH_SQL, /ON CONFLICT \(id, created_at\) DO NOTHING/);
  assert.match(ARCHIVE_BATCH_SQL, /FOR UPDATE SKIP LOCKED/);
  assert.match(ARCHIVE_BATCH_SQL, /DELETE FROM events e\s+USING verified v/);
  assert.match(ARCHIVE_BATCH_SQL, /IS NOT DISTINCT FROM c\.properties/);
});
