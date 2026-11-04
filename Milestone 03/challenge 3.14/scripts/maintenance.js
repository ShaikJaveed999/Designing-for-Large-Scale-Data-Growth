const db = require('../db');
const { archiveOldEvents } = require('./archive-events');

async function runMaintenance() {
  try {
    await db.query('SELECT ensure_event_partitions(3)');
    const archived = await archiveOldEvents();
    console.log(`Maintenance complete; archived ${archived} events.`);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  runMaintenance().catch((error) => {
    console.error('TrackFlow maintenance failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { runMaintenance };
