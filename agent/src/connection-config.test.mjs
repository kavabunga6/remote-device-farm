import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.mjs';
import { loadControlConfig } from './agent-control.mjs';
import { agentIdForToken } from '../../shared/agent-identity.mjs';
const token = 'rdfagent_' + 'example-credential-'.repeat(3);

test('server address and token are sufficient for both agent containers', () => {
  const env = { AGENT_SERVER_URL: 'https://farm.example.test:8443', AGENT_TOKEN: token };
  const io = loadConfig(env), control = loadControlConfig(env);
  assert.equal(io.brokerUrl, 'wss://farm.example.test:8443/agent/connect');
  assert.equal(io.agentId, agentIdForToken(token)); assert.equal(control.agentId, io.agentId);
  assert.equal(loadConfig({ ...env, AGENT_SERVER_URL: 'http://farm.example.test/' }).brokerUrl, 'ws://farm.example.test/agent/connect');
});
test('explicit legacy identity and broker remain supported', () => {
  const env = { AGENT_ID: 'legacy-node', AGENT_BROKER_URL: 'wss://farm.example.test/agent/connect', AGENT_TOKEN: token };
  assert.equal(loadConfig(env).agentId, 'legacy-node'); assert.equal(loadControlConfig(env).agentId, 'legacy-node');
  assert.equal(agentIdForToken(token), agentIdForToken(token)); assert.notEqual(agentIdForToken(token), agentIdForToken(token + 'x'));
});
test('server URLs reject credentials, unrelated paths and ambiguous overrides', () => {
  for (const server of ['file:///tmp/server', 'https://user:pass@farm.example.test', 'https://farm.example.test/unrelated', 'https://farm.example.test/?token=secret', 'https://farm.example.test/#token']) {
    assert.throws(() => loadConfig({ AGENT_SERVER_URL: server, AGENT_TOKEN: token }));
  }
  assert.throws(() => loadConfig({ AGENT_SERVER_URL: 'https://farm.example.test', AGENT_BROKER_URL: 'wss://other.example.test/agent/connect', AGENT_TOKEN: token }));
  assert.throws(() => loadConfig({ AGENT_SERVER_URL: 'https://farm.example.test', AGENT_TOKEN: '' }));
});
