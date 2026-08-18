import { DaemonServer } from './server.ts';

/**
 * Daemon entry point (D-001).
 *
 *   node src/core/daemon/main.ts
 *
 * Headless: no window, no audio, no clients of its own. Adapters attach over the socket.
 */
const server = new DaemonServer({ log: (message) => console.error(`[core] ${message}`) });

await server.listen();

const shutdown = (signal: NodeJS.Signals): void => {
  console.error(`[core] ${signal} — closing`);
  void server.close().then(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
