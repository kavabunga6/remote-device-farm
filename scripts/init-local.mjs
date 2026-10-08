#!/usr/bin/env node
// Prepare a NEW single-host installation. Never edit an existing installation or Docker's daemon configuration.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['.env', '.env.agent', 'compose.override.yaml', 'certs/ip.key', 'certs/ip.crt'];
const existing = targets.filter(name => existsSync(resolve(root, name)));
if (existing.length) throw new Error(`Refusing to overwrite an existing installation: ${existing.join(', ')}. See docs/deployment/server.md.`);
const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8', windowsHide: true });
if (openssl.status !== 0) throw new Error('OpenSSL is required to prepare the local nginx certificate.');
process.umask(0o077);
mkdirSync(resolve(root, 'certs'), { recursive: true, mode: 0o700 });
const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-keyout', resolve(root, 'certs/ip.key'), '-out', resolve(root, 'certs/ip.crt')], { encoding: 'utf8', windowsHide: true });
if (certificate.status !== 0) throw new Error('Could not create the local nginx certificate. Check OpenSSL and certs/ permissions.');
const token = randomBytes(32).toString('hex');
const write = (name, value) => writeFileSync(resolve(root, name), value, { flag: 'wx', mode: 0o600 });
write('.env', `POSTGRES_DB=devicefarm
POSTGRES_USER=devicefarm
POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}
HTTP_PORT=127.0.0.1:8088
PUBLIC_URL=http://localhost:8088
COOKIE_SECURE=false
TRUST_PROXY=1
AUTH_MODE=local
LOCAL_ADMIN_USERNAME=admin
LOCAL_ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}
BOOTSTRAP_AGENT_ID=agent-1
AGENT_TOKEN=${token}
SECRETS_KEY=${randomBytes(32).toString('base64')}
RDF_BUILTIN_REGISTRY_ADDRESS=localhost:5000
RDF_AUTO_IMAGE_BUILDER=true
`);
write('.env.agent', `AGENT_ID=agent-1
AGENT_NAME=Local host
AGENT_TOKEN=${token}
AGENT_BROKER_URL=ws://web:80/agent/connect
AGENT_SLOTS=1
AGENT_ALLOWED_IMAGE_PREFIXES=us-docker.pkg.dev/android-emulator-268719/images/,localhost:5000/rdf-emulator
`);
write('compose.override.yaml', `# Generated for one Linux host only. Every /v2/ request still goes through nginx authentication.
services:
  web:
    ports:
      - "127.0.0.1:5000:80"
    volumes:
      - ./certs/ip.crt:/etc/nginx/tls/ip.crt:ro
      - ./certs/ip.key:/etc/nginx/tls/ip.key:ro
`);
console.log(`Local configuration prepared; no service has been started.
Start on a Linux host with Docker and /dev/kvm:
  docker compose -f compose.yaml -f compose.agent.yaml -f compose.override.yaml up -d --build
Open http://localhost:8088. The admin password is in .env (LOCAL_ADMIN_PASSWORD).
Keep SECRETS_KEY separately from database backups. The local registry is localhost:5000.
For other nodes use a reachable HTTPS registry address; see docs/deployment/registry.md.`);
