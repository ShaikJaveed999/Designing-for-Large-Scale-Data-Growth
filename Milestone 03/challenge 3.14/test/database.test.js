const assert = require('node:assert/strict');
const test = require('node:test');

process.env.PRIMARY_DB_URL = 'postgresql://primary.example/trackflow';
const { createDatabase } = require('../db');

function createFakePoolClass() {
  const pools = [];

  class FakePool {
    constructor(options) {
      this.options = options;
      this.calls = [];
      this.endCalls = 0;
      pools.push(this);
    }

    query(text, params) {
      this.calls.push({ text, params });
      return Promise.resolve({ rows: [], pool: this });
    }

    async end() {
      this.endCalls += 1;
    }
  }

  return { FakePool, pools };
}

test('routes reads and writes to their configured pools', async () => {
  const { FakePool, pools } = createFakePoolClass();
  const database = createDatabase({
    PoolClass: FakePool,
    env: {
      PRIMARY_DB_URL: 'postgresql://primary.example/trackflow',
      REPLICA_DB_URL: 'postgresql://replica.example/trackflow',
    },
  });

  await database.query('INSERT INTO events DEFAULT VALUES');
  await database.readQuery('SELECT 1');
  await database.readQuery('SELECT 1', [], { consistency: 'primary' });

  assert.equal(pools.length, 2);
  assert.equal(pools[0].calls.length, 2);
  assert.equal(pools[1].calls.length, 1);
  assert.equal(database.primaryPool, pools[0]);
  assert.equal(database.replicaPool, pools[1]);
  await database.close();
  assert.equal(pools[0].endCalls, 1);
  assert.equal(pools[1].endCalls, 1);
});

test('falls back to the primary when no replica is configured', async () => {
  const { FakePool, pools } = createFakePoolClass();
  const database = createDatabase({
    PoolClass: FakePool,
    env: { PRIMARY_DB_URL: 'postgresql://primary.example/trackflow' },
  });

  await database.readQuery('SELECT 1');

  assert.equal(pools.length, 1);
  assert.equal(database.primaryPool, database.replicaPool);
  assert.equal(pools[0].calls.length, 1);
  await database.close();
});

test('reuses one pool when both URLs are identical', async () => {
  const { FakePool, pools } = createFakePoolClass();
  const url = 'postgresql://localhost/trackflow';
  const database = createDatabase({
    PoolClass: FakePool,
    env: { PRIMARY_DB_URL: url, REPLICA_DB_URL: url },
  });

  await database.readQuery('SELECT 1');

  assert.equal(pools.length, 1);
  assert.equal(database.primaryPool, database.replicaPool);
  await database.close();
});

test('requires a primary database URL', () => {
  const { FakePool } = createFakePoolClass();

  assert.throws(
    () => createDatabase({ PoolClass: FakePool, env: {} }),
    /PRIMARY_DB_URL/
  );
});
