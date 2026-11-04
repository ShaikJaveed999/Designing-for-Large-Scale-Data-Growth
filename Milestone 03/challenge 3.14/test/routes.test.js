const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const http = require('node:http');

process.env.PRIMARY_DB_URL = 'postgresql://primary.example/trackflow';

const calls = [];
const database = {
  async query(text, params) {
    calls.push({ kind: 'write', text, params });
    return { rows: [{ id: '1', event_type: 'test_event' }] };
  },
  async readQuery(text, params, options) {
    calls.push({ kind: 'read', text, params, options });
    return { rows: [] };
  },
};

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: database,
};

const app = require('../app');
const server = http.createServer(app);
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  calls.length = 0;
});

test('event writes use the primary and return read-after-write guidance', async () => {
  const response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 1, event_type: 'test_event', properties: {} }),
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-trackflow-consistency'), 'primary');
  assert.equal(calls[0].kind, 'write');
  assert.match(calls[0].text, /^INSERT INTO events/);
});

test('event reads use the replica by default and the primary on request', async () => {
  await fetch(`${baseUrl}/events?user_id=1`);
  await fetch(`${baseUrl}/events?user_id=1`, {
    headers: { 'X-TrackFlow-Consistency': 'primary' },
  });

  assert.deepEqual(calls.map((call) => call.options.consistency), ['eventual', 'primary']);
  assert.equal(calls.every((call) => call.kind === 'read'), true);
});

test('session and metric routes use primary for writes and replica for reads', async () => {
  await fetch(`${baseUrl}/sessions/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 1 }),
  });
  await fetch(`${baseUrl}/sessions/active`);
  await fetch(`${baseUrl}/metrics/monthly`);
  await fetch(`${baseUrl}/metrics/feature-usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 1, feature_name: 'dashboard' }),
  });

  assert.deepEqual(calls.map((call) => call.kind), ['write', 'read', 'read', 'write']);
  assert.equal(calls[1].options.consistency, 'eventual');
  assert.equal(calls[2].options.consistency, 'eventual');
  assert.equal(calls[3].text, 'INSERT INTO feature_usage (user_id, feature_name, used_at) VALUES ($1, $2, NOW()) RETURNING *');
});

test('archived events remain queryable and support primary consistency', async () => {
  const response = await fetch(`${baseUrl}/events/archive?user_id=1`, {
    headers: { 'X-TrackFlow-Consistency': 'primary' },
  });

  assert.equal(response.status, 200);
  assert.match(calls[0].text, /FROM events_archive/);
  assert.equal(calls[0].options.consistency, 'primary');
});
