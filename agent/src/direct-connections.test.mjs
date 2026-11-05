import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRtcConfig } from './rtc-config.mjs';
import { WebRtcManager } from './webrtc.mjs';

const rtcEnv = {
  AGENT_WEBRTC_ENABLED: '1', AGENT_WEBRTC_HOST_IP: '192.0.2.20',
  AGENT_WEBRTC_ICE_SERVERS: '[{"urls":"turn:relay.example:3478","username":"viewer","credential":"scoped"}]',
};

test('direct connections require a separate explicit opt-in even when WebRTC was enabled', () => {
  for (const value of [undefined, '', '0']) {
    const config = loadRtcConfig({ ...rtcEnv, AGENT_ALLOW_DIRECT_CONNECTIONS: value });
    assert.equal(config.enabled, false);
    assert.equal(config.directConnectionsAllowed, false);
  }
  const allowed = loadRtcConfig({ ...rtcEnv, AGENT_ALLOW_DIRECT_CONNECTIONS: '1' });
  assert.equal(allowed.enabled, true);
  assert.equal(allowed.directConnectionsAllowed, true);
  assert.equal(loadRtcConfig({ AGENT_ALLOW_DIRECT_CONNECTIONS: '1' }).enabled, false);
});

test('invalid direct-connection policy is rejected rather than enabling a public listener', () => {
  for (const value of ['true', 'false', 'yes', '2', ' 1']) {
    assert.throws(() => loadRtcConfig({ ...rtcEnv, AGENT_ALLOW_DIRECT_CONNECTIONS: value }), /AGENT_ALLOW_DIRECT_CONNECTIONS/);
  }
});

test('server-only agents expose no ICE endpoints and reject offers before creating a peer', async () => {
  let peers = 0;
  const rtc = new WebRtcManager({
    config: loadRtcConfig(rtcEnv), streams: { streams: new Map() },
    createPeer: () => { peers++; throw new Error('A direct peer must not be created'); },
  });
  const capabilities = rtc.capabilities();
  assert.equal(capabilities.available, false);
  assert.deepEqual(capabilities.iceServers, []);
  assert.equal(typeof capabilities.reason, 'string');
  assert.doesNotMatch(JSON.stringify(capabilities), /192\.0\.2\.20|relay\.example|scoped/);
  await assert.rejects(rtc.offer('session', 'device:5555', {
    peerId: '11111111-2222-3333-4444-555555555555',
    description: { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 100\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' },
    canControl: true,
  }), { message: capabilities.reason });
  assert.equal(peers, 0);
  assert.equal(rtc.peers.size, 0);
});
