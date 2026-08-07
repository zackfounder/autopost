import { initSchema } from '../db/index.ts';
import { startServer } from './http.ts';
import { engine } from '../engine/scheduler.ts';
import { closeAllSessions } from '../browser/session.ts';

initSchema();
startServer();

// The engine does not auto-start. You press the button (or POST /api/engine/start)
// — nothing touches a LinkedIn account because a process happened to boot.
console.log('Engine is stopped. Start it from the dashboard when you are ready.');

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`\n${sig} — finishing the current action, then closing the browser…`);
    await engine.stop();
    await closeAllSessions();
    process.exit(0);
  });
}
