import { loadAppStoreConfig, type AppStoreConfig } from './app-store.js';

export type AuthMode = 'local' | 'ldap' | 'oidc' | 'none';

export type Config = {
  // App library and install-from-URL.
  apps: AppStoreConfig;
  port: number;
  databaseUrl: string;
  authMode: AuthMode;
  agentToken: string;
  bootstrapAgentId: string;
  adminToken?: string;
  publicUrl?: string;
  localAdminUsername?: string;
  localAdminPassword?: string;
  adminSubjects: Set<string>;
  ldap?: { url: string; baseDn: string; bindDn: string; bindPassword: string; userFilter: string };
  oidc?: { issuer: string; clientId: string; clientSecret: string };
  secureCookies: boolean;
  allowedOrigins: Set<string>;
  adbPorts?: { host: string; start: number; count: number };
  // Number of reverse proxies in front of the server; unset means client addresses are not trusted.
  trustProxy?: number;
  // Fair use of slots; 0 turns a limit off.
  maxSessionsPerUser: number;
  idleTimeoutMinutes: number;
  maxSessionHours: number;
  // Waiting list and webhooks.
  queueTtlMinutes: number;
  webhookAllowHttp: boolean;
  webhookAllowPrivate: boolean;
  // GET /metrics is disabled unless this bearer token is set.
  metricsToken?: string;
  // Seconds between slot usage samples for the ops charts; 0 turns the sampler off.
  opsSampleSeconds: number;
  // Key for encrypting profile container variables; when unset a random key is generated once and kept in the database.
  secretsKey?: string;
  builtinRegistryAddress?: string;
  autoImageBuilder?: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.AUTH_MODE || 'local';
  if (!['local', 'ldap', 'oidc', 'none'].includes(mode)) throw new Error('AUTH_MODE must be local, ldap, oidc or none');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.AGENT_TOKEN || env.AGENT_TOKEN.length < 32) throw new Error('AGENT_TOKEN must be at least 32 characters');
  if (!env.BOOTSTRAP_AGENT_ID || !/^[A-Za-z0-9._-]{1,100}$/.test(env.BOOTSTRAP_AGENT_ID)) throw new Error('BOOTSTRAP_AGENT_ID must match the initial agent AGENT_ID');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a TCP port');
  const authMode = mode as AuthMode;
  if (authMode === 'local' && (!env.LOCAL_ADMIN_USERNAME || !env.LOCAL_ADMIN_PASSWORD || env.LOCAL_ADMIN_PASSWORD.length < 12)) {
    throw new Error('local auth needs LOCAL_ADMIN_USERNAME and LOCAL_ADMIN_PASSWORD of at least 12 characters');
  }
  if (authMode === 'none' && (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32)) {
    throw new Error('no-auth mode needs ADMIN_TOKEN of at least 32 characters for administration');
  }
  let ldap: Config['ldap'];
  if (authMode === 'ldap') {
    if (!env.LDAP_URL?.startsWith('ldaps://') || !env.LDAP_BASE_DN || !env.LDAP_BIND_DN || !env.LDAP_BIND_PASSWORD) {
      throw new Error('LDAP_URL (ldaps://), LDAP_BASE_DN, LDAP_BIND_DN and LDAP_BIND_PASSWORD are required');
    }
    ldap = { url: env.LDAP_URL, baseDn: env.LDAP_BASE_DN, bindDn: env.LDAP_BIND_DN, bindPassword: env.LDAP_BIND_PASSWORD, userFilter: env.LDAP_USER_FILTER || '(uid={{username}})' };
    if (!ldap.userFilter.includes('{{username}}')) throw new Error('LDAP_USER_FILTER must include {{username}}');
  }
  let oidc: Config['oidc'];
  if (authMode === 'oidc') {
    if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.PUBLIC_URL) {
      throw new Error('OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and PUBLIC_URL are required');
    }
    oidc = { issuer: env.OIDC_ISSUER.replace(/\/$/, ''), clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET };
    if (!oidc.issuer.startsWith('https://')) throw new Error('OIDC_ISSUER must use HTTPS');
  }
  if (env.PUBLIC_URL && !/^https?:\/\//.test(env.PUBLIC_URL)) throw new Error('PUBLIC_URL must be HTTP(S)');
  const publicUrl = env.PUBLIC_URL?.replace(/\/$/, '');
  const allowedOrigins = new Set<string>();
  if (publicUrl) allowedOrigins.add(new URL(publicUrl).origin);
  if (env.FRONTEND_ORIGIN) allowedOrigins.add(new URL(env.FRONTEND_ORIGIN).origin);
  let adbPorts: Config['adbPorts'];
  if (env.ADB_PUBLIC_HOST || env.ADB_PORT_START || env.ADB_PORT_COUNT) {
    const start = Number(env.ADB_PORT_START);
    const count = Number(env.ADB_PORT_COUNT);
    const host = env.ADB_PUBLIC_HOST || '';
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) ||
        !Number.isInteger(start) || start < 1024 || start > 65535 ||
        !Number.isInteger(count) || count < 1 || count > 32 || start + count - 1 > 65535) {
      throw new Error('ADB_PUBLIC_HOST, ADB_PORT_START and ADB_PORT_COUNT must define a bounded broker TCP range');
    }
    adbPorts = { host, start, count };
  }
  let trustProxy: number | undefined;
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== '') {
    trustProxy = Number(env.TRUST_PROXY);
    if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 5) throw new Error('TRUST_PROXY must be the number of reverse proxies (0-5)');
  }
  const limit = (name: string, fallback: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} must be an integer from 0 to ${max}`);
    return value;
  };
  const metricsToken = env.METRICS_TOKEN || undefined;
  if (metricsToken !== undefined && metricsToken.length < 16) throw new Error('METRICS_TOKEN must be at least 16 characters');
  return {
    port,
    databaseUrl: env.DATABASE_URL,
    authMode,
    agentToken: env.AGENT_TOKEN,
    bootstrapAgentId: env.BOOTSTRAP_AGENT_ID,
    adminToken: env.ADMIN_TOKEN,
    publicUrl,
    localAdminUsername: env.LOCAL_ADMIN_USERNAME,
    localAdminPassword: env.LOCAL_ADMIN_PASSWORD,
    adminSubjects: new Set((env.ADMIN_SUBJECTS || '').split(',').map(v => v.trim()).filter(Boolean)),
    ldap,
    oidc,
    secureCookies: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && !!publicUrl?.startsWith('https://')),
    allowedOrigins,
    adbPorts,
    trustProxy,
    maxSessionsPerUser: limit('MAX_SESSIONS_PER_USER', 3, 100),
    idleTimeoutMinutes: limit('IDLE_TIMEOUT_MINUTES', 0, 7 * 24 * 60),
    maxSessionHours: limit('MAX_SESSION_HOURS', 0, 24 * 30),
    queueTtlMinutes: Math.max(1, limit('QUEUE_TTL_MINUTES', 30, 24 * 60)),
    webhookAllowHttp: env.WEBHOOK_ALLOW_HTTP === 'true',
    webhookAllowPrivate: env.WEBHOOK_ALLOW_PRIVATE === 'true',
    metricsToken,
    opsSampleSeconds: limit('OPS_SAMPLE_SECONDS', 60, 3600),
    secretsKey: env.SECRETS_KEY || undefined,
    builtinRegistryAddress: env.RDF_BUILTIN_REGISTRY_ADDRESS || undefined,
    autoImageBuilder: env.RDF_AUTO_IMAGE_BUILDER === 'true' || env.RDF_AUTO_IMAGE_BUILDER === '1',
    apps: loadAppStoreConfig(env),
  };
}
