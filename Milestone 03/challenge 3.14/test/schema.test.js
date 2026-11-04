const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');

test('schema uses date-range partitions with three months pre-created', () => {
  const schema = readFileSync(join(root, 'schema.sql'), 'utf8');

  assert.match(schema, /PARTITION BY RANGE \(created_at\)/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION ensure_event_partitions/);
  assert.match(schema, /SELECT ensure_event_partitions\(3\)/);
  assert.match(schema, /months_ahead < 3/);
});

test('event archive is keyed for duplicate prevention and indexed for queries', () => {
  const schema = readFileSync(join(root, 'schema.sql'), 'utf8');

  assert.match(schema, /CREATE TABLE events_archive/);
  assert.match(schema, /PRIMARY KEY \(id, created_at\)/);
  assert.match(schema, /events_archive_user_created_at_idx/);
});

test('monthly maintenance is scheduled as a nightly Render cron job', () => {
  const configuration = readFileSync(join(root, '..', '..', 'render.yaml'), 'utf8');

  assert.match(configuration, /type: cron/);
  assert.match(configuration, /schedule: "0 2 \* \* \*"/);
  assert.match(configuration, /startCommand: npm run maintenance/);
});
