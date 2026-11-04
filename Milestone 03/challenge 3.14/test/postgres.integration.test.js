const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const http = require('node:http');

process.env.PRIMARY_DB_URL = 'postgresql://primary.example/trackflow';
const { archiveOldEvents } = require('../scripts/archive-events');

const root = join(__dirname, '..');
let applicationDatabase;
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: (text, params) => applicationDatabase.query(text, params),
    readQuery: (text, params) => applicationDatabase.query(text, params),
  },
};
const app = require('../app');

function createPoolAdapter(database) {
  return {
    async connect() {
      return {
        query: (text, params) => database.query(text, params),
        release() {},
      };
    },
  };
}

test('PostgreSQL schema partitions inserts and archives safely', async () => {
  const database = new PGlite();

  try {
    await database.exec(readFileSync(join(root, 'schema.sql'), 'utf8'));
    await database.query(
      "INSERT INTO users (email) VALUES ('integration@example.test')"
    );

    const inserted = await database.query(
      `INSERT INTO events (user_id, event_type, properties)
       VALUES (1, 'partition_test', '{"source":"integration"}')
       RETURNING id, created_at, tableoid::regclass::text AS partition_name`
    );
    const partitionName = `events_${new Date(inserted.rows[0].created_at).toISOString().slice(0, 7).replace('-', '_')}`;

    assert.equal(inserted.rows[0].partition_name, partitionName);

    const partitions = await database.query(
      `SELECT inhrelid::regclass::text AS partition_name
       FROM pg_inherits
       WHERE inhparent = 'events'::regclass`
    );
    assert.ok(partitions.rows.length >= 3);

    const insertedAt = new Date(inserted.rows[0].created_at);
    const start = new Date(Date.UTC(insertedAt.getUTCFullYear(), insertedAt.getUTCMonth(), 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const plan = await database.query(
      'EXPLAIN (COSTS OFF) SELECT * FROM events WHERE created_at >= $1 AND created_at < $2',
      [start, end]
    );
    const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');

    assert.match(planText, new RegExp(partitionName));
    assert.equal(new Set(planText.match(/events_20\d{2}_\d{2}/g) || []).size, 1);

    applicationDatabase = database;
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const writeResponse = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: 1,
          event_type: 'http_event',
          properties: { source: 'http-integration' },
        }),
      });
      assert.equal(writeResponse.status, 201);
      assert.equal(writeResponse.headers.get('x-trackflow-consistency'), 'primary');

      const readResponse = await fetch(`${baseUrl}/events?user_id=1`, {
        headers: { 'X-TrackFlow-Consistency': 'primary' },
      });
      const readRows = await readResponse.json();
      assert.equal(readResponse.status, 200);
      assert.equal(readRows.some((row) => row.event_type === 'http_event'), true);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      applicationDatabase = undefined;
    }

    const first = await database.query(
      `INSERT INTO events (user_id, event_type, properties)
       VALUES (1, 'archive_test', '{"source":"first"}')
       RETURNING id, user_id, session_id, event_type, properties, created_at`
    );
    const second = await database.query(
      `INSERT INTO events (user_id, event_type, properties)
       VALUES (1, 'archive_test', '{"source":"second"}')
       RETURNING id, user_id, session_id, event_type, properties, created_at`
    );

    const firstRow = first.rows[0];
    const secondRow = second.rows[0];
    await database.query(
      `INSERT INTO events_archive
         (id, user_id, session_id, event_type, properties, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        firstRow.id,
        firstRow.user_id,
        firstRow.session_id,
        firstRow.event_type,
        firstRow.properties,
        firstRow.created_at,
      ]
    );
    await database.query(
      `INSERT INTO events_archive
         (id, user_id, session_id, event_type, properties, created_at)
       VALUES ($1, $2, $3, 'conflicting_type', $4, $5)`,
      [
        secondRow.id,
        secondRow.user_id,
        secondRow.session_id,
        secondRow.properties,
        secondRow.created_at,
      ]
    );

    const pool = createPoolAdapter(database);
    const now = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
    await assert.rejects(
      archiveOldEvents({ pool, now, batchSize: 10 }),
      /verified 3 of 4/
    );

    const activeAfterConflict = await database.query(
      'SELECT COUNT(*)::INTEGER AS count FROM events WHERE id IN ($1, $2)',
      [firstRow.id, secondRow.id]
    );
    assert.equal(activeAfterConflict.rows[0].count, 2);

    await database.query(
      `UPDATE events_archive
       SET event_type = $1
       WHERE id = $2 AND created_at = $3`,
      [secondRow.event_type, secondRow.id, secondRow.created_at]
    );
    assert.equal(await archiveOldEvents({ pool, now, batchSize: 10 }), 4);

    const remaining = await database.query(
      'SELECT COUNT(*)::INTEGER AS count FROM events WHERE id IN ($1, $2)',
      [firstRow.id, secondRow.id]
    );
    const archived = await database.query(
      'SELECT COUNT(*)::INTEGER AS count FROM events_archive WHERE id IN ($1, $2)',
      [firstRow.id, secondRow.id]
    );
    assert.equal(remaining.rows[0].count, 0);
    assert.equal(archived.rows[0].count, 2);
  } finally {
    await database.close();
  }
});

test('existing starter schema migrates without losing rows or identity sequence state', async () => {
  const database = new PGlite();

  try {
    await database.exec(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(100) UNIQUE NOT NULL,
        plan VARCHAR(20) DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER
      );
      CREATE TABLE events (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        session_id INTEGER REFERENCES sessions(id),
        event_type VARCHAR(50) NOT NULL,
        properties JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO users (email) VALUES ('migration@example.test');
      INSERT INTO events (id, user_id, event_type) VALUES (41, 1, 'before_migration');
    `);
    await database.exec(readFileSync(join(root, 'migrations', '001_partition_events.sql'), 'utf8'));

    const oldEvent = await database.query(
      "SELECT event_type FROM events WHERE id = 41"
    );
    const newEvent = await database.query(
      `INSERT INTO events (user_id, event_type)
       VALUES (1, 'after_migration')
       RETURNING id, tableoid::regclass::text AS partition_name`
    );

    assert.equal(oldEvent.rows[0].event_type, 'before_migration');
    assert.equal(Number(newEvent.rows[0].id), 42);
    assert.match(newEvent.rows[0].partition_name, /^events_20\d{2}_\d{2}$/);
  } finally {
    await database.close();
  }
});
