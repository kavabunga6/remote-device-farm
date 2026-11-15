import { isIPv4 } from 'node:net';
import { diagnostic } from './diagnostics.mjs';
import policy from './network-policy.json' with { type: 'json' };

// A locally administered address, reused only on separate per-session bridges.
// The host firewall reads the same resource. Emulator endpoints retain Docker's
// own addresses and cannot spoof this identity without raw/admin capabilities.
export const MANAGEMENT_AGENT_MAC = policy.managementAgentMac;

// Only the trusted control process invokes this fixed program in the I/O agent.
// Its temporary NET_ADMIN access is confined to that container's network namespace;
// emulator containers and the long-running I/O process keep their original caps.
export const MANAGEMENT_ENDPOINT_PROGRAM = `
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [address, mac, repair] = process.argv.slice(1);
if (!/^02(:[0-9a-f]{2}){5}$/.test(mac)) process.exit(1);
const matches = Object.entries(os.networkInterfaces()).filter(([, entries]) =>
  entries.some(entry => entry.family === 'IPv4' && entry.address === address));
if (matches.length !== 1 || !/^[a-zA-Z0-9_.:-]{1,15}$/.test(matches[0][0])) process.exit(1);
const name = matches[0][0];
const read = () => fs.readFileSync('/sys/class/net/' + name + '/address', 'utf8').trim();
if (read() !== mac && repair === 'yes')
  execFileSync('/usr/sbin/ip', ['link', 'set', 'dev', name, 'address', mac], { timeout: 5000, stdio: 'ignore' });
if (read() !== mac) process.exit(1);
`;

export async function verifyManagementEndpoint(docker, containerId, endpoint, { newlyAttached }) {
  const fail = () => new Error(diagnostic('docker.39674334a3', { p0: 'management endpoint' }));
  if (!isIPv4(endpoint?.IPAddress)) throw fail();
  const repair = newlyAttached && endpoint.MacAddress?.toLowerCase() !== MANAGEMENT_AGENT_MAC;
  const exec = await docker.request('POST', `/containers/${encodeURIComponent(containerId)}/exec`, {
    User: '0', Privileged: repair, AttachStdout: true, AttachStderr: true,
    Cmd: ['node', '--input-type=module', '-e', MANAGEMENT_ENDPOINT_PROGRAM,
      endpoint.IPAddress, MANAGEMENT_AGENT_MAC, repair ? 'yes' : 'no'],
  });
  if (!exec?.Id) throw fail();
  await docker.requestRaw('POST', `/exec/${encodeURIComponent(exec.Id)}/start`, { Detach: false, Tty: false }, { timeoutMs: 10000, maxBytes: 1024 });
  const result = await docker.request('GET', `/exec/${encodeURIComponent(exec.Id)}/json`);
  if (result?.Running !== false || result.ExitCode !== 0) throw fail();
}
