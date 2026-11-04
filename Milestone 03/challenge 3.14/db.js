const { Pool } = require('pg');
require('dotenv').config();

function createDatabase({ PoolClass = Pool, env = process.env } = {}) {
  const primaryUrl = env.PRIMARY_DB_URL || env.DATABASE_URL;
  const replicaUrl = env.REPLICA_DB_URL;

  if (!primaryUrl) {
    throw new Error('PRIMARY_DB_URL (or the legacy DATABASE_URL) must be configured');
  }

  const primaryPool = new PoolClass({ connectionString: primaryUrl });
  const replicaPool = replicaUrl && replicaUrl !== primaryUrl
    ? new PoolClass({ connectionString: replicaUrl })
    : primaryPool;

  return {
    query: (text, params) => primaryPool.query(text, params),
    readQuery: (text, params, { consistency = 'eventual' } = {}) => {
      if (consistency !== 'eventual' && consistency !== 'primary') {
        throw new Error(`Unsupported read consistency: ${consistency}`);
      }

      const pool = consistency === 'primary' ? primaryPool : replicaPool;
      return pool.query(text, params);
    },
    primaryPool,
    replicaPool,
    pool: primaryPool,
    close: async () => {
      if (replicaPool !== primaryPool) {
        await replicaPool.end();
      }
      await primaryPool.end();
    },
  };
}

module.exports = { ...createDatabase(), createDatabase };
