import { agentMessage } from './messages.mjs';

const IMAGE_LABEL = 'remote-device-farm.network-proxy';
const KIND_LABEL = 'remote-device-farm.network-proxy-helper';
const PARENT_LABEL = 'remote-device-farm.network-proxy.parent';
const SESSION_LABEL = 'remote-device-farm.session';
const AGENT_LABEL = 'remote-device-farm.agent';
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const HELPER_MEMORY = 128 * 1024 * 1024;
const OPERATION_TIMEOUT = 45_000;
const CLEANUP_TIMEOUT = 20_000;
const LOOKUP_TIMEOUT = 5_000;
const MUTATION_TIMEOUT = 10_000;
const containerId = (value) => typeof value === 'string' && CONTAINER_ID.test(value);
const imageId = (value) => typeof value === 'string' && IMAGE_ID.test(value);

function fail() {
  throw new Error(agentMessage('networkInspector.failed'));
}

function requestOptions(deadline, limit = LOOKUP_TIMEOUT) {
  if (typeof deadline !== 'number') fail();
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining < 1) fail();
  return { timeoutMs: Math.min(remaining, limit) };
}

function validateOwner(session, agent) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(session) ||
      typeof agent !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(agent)) fail();
}

function missing(error) {
  return /^(?:No such container(?::|$)|404(?: No such container(?::|$)|$)|Docker API HTTP 404$)/i.test(error?.message ?? '');
}

function verifyOwner(container, session, agent, parent) {
  const labels = container?.Config?.Labels;
  const owner = labels?.[PARENT_LABEL];
  if (!containerId(container?.Id) || labels?.[KIND_LABEL] !== 'true' ||
      labels[SESSION_LABEL] !== session || labels[AGENT_LABEL] !== agent || !containerId(owner) ||
      (parent !== undefined && owner !== parent) || container.HostConfig?.NetworkMode !== 'container:' + owner) fail();
}

async function inspectHelper(docker, selector, deadline) {
  try {
    return await docker.inspect(selector, requestOptions(deadline));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function removeHelper(docker, id, deadline) {
  try {
    await docker.request('DELETE', `/containers/${id}?force=true&v=true`, undefined, requestOptions(deadline, MUTATION_TIMEOUT));
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function helperName(session) {
  return `rdf-network-proxy-${session}`;
}

export function networkProxySpec(image, parent, session, agent) {
  validateOwner(session, agent);
  if (!imageId(image) || !containerId(parent)) fail();
  return {
    Image: image,
    User: '10001:10001',
    Entrypoint: ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', '/usr/bin/python3', '-I', '-B', '/app/src/network-proxy.py'],
    Cmd: ['serve'],
    Labels: { [KIND_LABEL]: 'true', [PARENT_LABEL]: parent, [SESSION_LABEL]: session, [AGENT_LABEL]: agent },
    HostConfig: {
      NetworkMode: 'container:' + parent,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Init: true,
      Memory: HELPER_MEMORY,
      MemorySwap: HELPER_MEMORY,
      NanoCpus: 500_000_000,
      PidsLimit: 96,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'none' },
      Tmpfs: { '/rdf-network': 'rw,nosuid,nodev,noexec,size=8m,mode=0700,uid=10001,gid=10001' },
      Binds: [],
    },
  };
}

export async function removeNetworkProxies(docker, session, agent) {
  validateOwner(session, agent);
  const deadline = Date.now() + CLEANUP_TIMEOUT;
  const filters = JSON.stringify({ label: [`${KIND_LABEL}=true`, `${SESSION_LABEL}=${session}`, `${AGENT_LABEL}=${agent}`] });
  const helpers = await docker.request('GET', `/containers/json?all=true&filters=${encodeURIComponent(filters)}`, undefined, requestOptions(deadline));
  for (const { Id } of helpers) {
    if (!containerId(Id)) fail();
    const container = await inspectHelper(docker, Id, deadline);
    if (!container) continue;
    verifyOwner(container, session, agent);
    if (container.Id !== Id) fail();
    await removeHelper(docker, Id, deadline);
  }
}

export class NetworkProxyContainer {
  constructor(docker, { agentId, selfContainerId, image } = {}) {
    Object.assign(this, { docker, agentId, selfContainerId, image });
  }

  async imageId(deadline = Date.now() + OPERATION_TIMEOUT) {
    let image = this.image;
    if (!image) {
      if (typeof this.selfContainerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(this.selfContainerId)) fail();
      image = (await this.docker.inspect(this.selfContainerId, requestOptions(deadline))).Image;
      if (!imageId(image)) fail();
    }
    const detail = await this.docker.request('GET', `/images/${encodeURIComponent(image)}/json`, undefined, requestOptions(deadline));
    if (!imageId(detail?.Id) || detail.Config?.Labels?.[IMAGE_LABEL] !== '1' ||
        Object.keys(detail.Config?.Volumes ?? {}).length || (imageId(image) && detail.Id !== image))
      throw new Error(agentMessage('networkInspector.unavailable'));
    return detail.Id;
  }

  async available(deadline = Date.now() + OPERATION_TIMEOUT) {
    try {
      await this.imageId(deadline);
      return true;
    } catch {
      return false;
    }
  }

  async container(parent, session, deadline = Date.now() + OPERATION_TIMEOUT) {
    validateOwner(session, this.agentId);
    if (!containerId(parent)) fail();
    const container = await inspectHelper(this.docker, helperName(session), deadline);
    if (container) verifyOwner(container, session, this.agentId, parent);
    return container;
  }

  async start(parent, session, deadline = Date.now() + OPERATION_TIMEOUT) {
    const existing = await this.container(parent, session, deadline);
    if (existing?.State?.Running === true) return existing;
    const spec = networkProxySpec(await this.imageId(deadline), parent, session, this.agentId);
    if (existing) await removeHelper(this.docker, existing.Id, deadline);
    // An uncertain Docker reply can be reconciled by the deterministic name on the next request.
    const created = await this.docker.request('POST', `/containers/create?name=${helperName(session)}`, spec, requestOptions(deadline, MUTATION_TIMEOUT));
    if (!containerId(created?.Id)) fail();
    await this.docker.request('POST', `/containers/${created.Id}/start`, undefined, requestOptions(deadline, MUTATION_TIMEOUT));
    const running = await this.container(parent, session, deadline);
    if (running?.Id !== created.Id || running.State?.Running !== true) fail();
    return running;
  }
}
