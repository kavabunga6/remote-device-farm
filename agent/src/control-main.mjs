import { initializeControl } from './control-startup.mjs';
import { AgentControl, loadControlConfig } from './agent-control.mjs';
import { createControlServer } from './control-ipc.mjs';

const control = new AgentControl(loadControlConfig());
try { await initializeControl(control); }
catch { console.error(JSON.stringify({ event: 'control.startup_failed', code: 'dependency_unavailable' })); process.exit(1); }
const server = await createControlServer(control);
console.log('Agent control IPC is ready');

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
