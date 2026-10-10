import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { migrate } from '../../src/db.js';
import { loadConfig } from '../../src/config.js';
import { AuthService, hashPassword } from '../../src/auth.js';
import { AgentHub } from '../../src/agent.js';
import { createServerContext } from '../../src/server-context.js';
import { createHttpApplication } from '../../src/http-application.js';
import { ApplicationLog } from '../../src/application-log.js';
import { AdbPortBroker } from '../../src/adb-port.js';
import { ImageBuildWorker } from '../../src/image-build-worker.js';
import { ImagePrewarmWorker } from '../../src/image-prewarm.js';
import { ImageManagement } from '../../src/image-management.js';
import { attachWebSocket } from '../../src/websocket.js';

export const credentials = { username: 'contract-admin', password: 'Synthetic-test-password-42' };
export const memberCredentials = { username: 'contract-member', password: 'Synthetic-test-password-43' };
/** PGlite has one connection; pooled queries must wait for transaction release. */
export function testPool(db: PGlite): Pool {
  let tail = Promise.resolve();
  async function acquire() {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
  async function query(sql: string, values?: unknown[]) {
    const result = values === undefined ? (await db.exec(sql)).at(-1)! : await db.query(sql, values);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  }
  return {
    query: async (sql: string, values?: unknown[]) => {
      const release = await acquire();
      try {
        return await query(sql, values);
      } finally {
        release();
      }
    },
    connect: async () => {
      const release = await acquire();
      return { query, release };
    },
    end: async () => {
      await tail;
      await db.close();
    },
  } as unknown as Pool;
}
/** Only device RPC is simulated; routing, SQL, auth and cleanup are production code. */
class TestAgent extends AgentHub {
  readonly launches: Array<Record<string, unknown>> = [];
  private proxy = { enabled: false, host: '', port: 0 };
  override hasAgent() {
    return true;
  }
  override supportsNodePolicy() {
    return true;
  }
  override refreshStream() {}
  override async command(
    _hostId: string,
    _sessionId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (action === 'start') {
      this.launches.push(params);
      return { containerId: 'synthetic-container' };
    }
    if (action === 'stop' || action === 'kill') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {};
    }
    if (action === 'env') {
      if (params.op === 'proxy') {
        const p = params.params as Record<string, unknown>;
        this.proxy = !p.reset
          ? { enabled: true, host: String(p.host), port: Number(p.port) }
          : { enabled: false, host: '', port: 0 };
      }
      return params.op === 'read'
        ? {
            proxy: this.proxy,
            darkMode: 'auto',
            fontScale: 1,
            animations: true,
            showTouches: false,
            pointerLocation: false,
            timezone: 'UTC',
            size: null,
            density: null,
            battery: null,
          }
        : { ok: true };
    }
    if (action === 'logcat') return { entries: [], cursor: null, app: null };
    if (action === 'logcat-apps') return { apps: [] };
    return {};
  }
}
export async function apiFixture({ port = 0, origin }: { port?: number; origin?: string } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rdf-api-contract-'));
  const pool = testPool(new PGlite());
  let hub: TestAgent | undefined;
  try {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/contract',
      AUTH_MODE: 'local',
      AGENT_TOKEN: 'synthetic-test-agent-token-not-for-deployment',
      BOOTSTRAP_AGENT_ID: 'contract-node',
      LOCAL_ADMIN_USERNAME: credentials.username,
      LOCAL_ADMIN_PASSWORD: credentials.password,
      APP_STORE_DIR: dir,
      COOKIE_SECURE: 'false',
      OPS_SAMPLE_SECONDS: '0',
      ...(origin ? { FRONTEND_ORIGIN: origin } : {}),
    });
    await migrate(pool);
    const auth = new AuthService(pool, config);
    await auth.bootstrap();
    await pool.query(
      "INSERT INTO users(id,provider,subject,username,display_name,role,password_hash) VALUES('11111111-1111-4111-8111-111111111111','local',$1,$1,'Contract Member','user',$2)",
      [memberCredentials.username, await hashPassword(memberCredentials.password)],
    );
    await pool.query(
      "INSERT INTO profiles(id,name,android_version,image,cpu,memory_mb,guest_cores,guest_memory_mb,disk_gb,allow_launch_overrides) VALUES('contract-profile','Contract Android','11','example.invalid/emulator:11',4,4096,2,2048,8,true)",
    );
    await pool.query(
      "INSERT INTO hosts(id,name,slots,status,last_seen_at,manual_slots,slot_cpu,slot_memory_mb,metrics) VALUES('contract-node','Contract Node',2,'online',now(),2,4,4096,'{}')",
    );
    await pool.query(
      "INSERT INTO host_slots(host_id,slot_index) VALUES('contract-node',0),('contract-node',1)",
    );
    hub = new TestAgent(pool);
    const context = createServerContext(pool, config, auth, undefined, hub);
    const adbPortBroker = new AdbPortBroker(pool, hub, config);
    const services = {
      applicationLog: new ApplicationLog(2000),
      adbPortBroker,
      imageBuilds: new ImageBuildWorker(pool, hub, config.secretsKey),
      imageManagement: new ImageManagement(pool, hub),
      imagePrewarm: new ImagePrewarmWorker(pool, hub, config.secretsKey),
    };
    const { app, stopAuth, stopApplicationLog, queue, stopOps } = createHttpApplication(context, services, {
      startDispatcher: false,
    });
    const server = createServer(app),
      stopWebSocket = attachWebSocket(server, context);
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Listener address is unavailable');
    const heartbeat = setInterval(
      () => void pool.query("UPDATE hosts SET last_seen_at=now() WHERE id='contract-node'"),
      10_000,
    );
    heartbeat.unref();
    const activeHub = hub;
    let closed = false;
    return {
      app,
      pool,
      hub,
      url: `http://127.0.0.1:${address.port}`,
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        await Promise.all([
          stopAuth(),
          stopApplicationLog(),
          queue?.stop(),
          stopOps(),
          stopWebSocket(),
          adbPortBroker.stop(),
          activeHub.dispose(),
        ]);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.end();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await hub?.dispose();
    await pool.end();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
