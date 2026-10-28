import test from 'node:test';
import assert from 'node:assert/strict';
import {PcapWriter,PACKET_FILTER} from './packet-capture-worker.mjs';
import {packetCaptureSpec,removePacketCaptures} from './packet-capture.mjs';
const header=()=>{const b=Buffer.alloc(24);b.writeUInt32LE(0xa1b2c3d4);b.writeUInt16LE(2,4);b.writeUInt16LE(4,6);b.writeUInt32LE(65535,16);b.writeUInt32LE(276,20);return b;};
const packet=bytes=>{const b=Buffer.alloc(16);b.writeUInt32LE(bytes.length,8);b.writeUInt32LE(bytes.length,12);return Buffer.concat([b,bytes]);};
test('packet framing preserves split records and stops at a complete packet within its byte bound',()=>{
  const chunks=[];let stopped=0;const p=packet(Buffer.from('hello'));
  const writer=new PcapWriter(x=>chunks.push(Buffer.from(x)),()=>stopped++,24+p.length);
  const data=Buffer.concat([header(),p,p]);for(let i=0;i<data.length;i+=3)writer.accept(data.subarray(i,i+3));
  assert.equal(stopped,1);assert.equal(writer.records,1);assert.deepEqual(Buffer.concat(chunks),Buffer.concat([header(),p]));
  const bad=new PcapWriter(()=>{},()=>{});assert.throws(()=>bad.accept(Buffer.alloc(24)),/header/);
  const oversized=packet(Buffer.from('a'));oversized.writeUInt32LE(65536,8);const invalid=new PcapWriter(()=>{},()=>{});assert.throws(()=>invalid.accept(Buffer.concat([header(),oversized])),/packet_size/);
});
test('packet helper has bounded capabilities in its exact emulator namespace and no host access or raw Docker logs',()=>{
  const spec=packetCaptureSpec('sha256:'+'a'.repeat(64),'b'.repeat(64),'session-1234','agent','c'.repeat(32));
  assert.deepEqual(spec.HostConfig.CapDrop,['ALL']);assert.deepEqual(spec.HostConfig.CapAdd,['NET_RAW','SETGID']);
  assert.equal(spec.HostConfig.NetworkMode,'container:'+'b'.repeat(64));assert.deepEqual(spec.HostConfig.Binds,[]);
  assert.equal(spec.HostConfig.ReadonlyRootfs,true);assert.equal(spec.HostConfig.LogConfig.Type,'none');
  assert.equal(spec.HostConfig.Memory,128*1024*1024);assert.equal(spec.HostConfig.NanoCpus,250000000);assert.equal(spec.HostConfig.PidsLimit,32);
  assert.deepEqual(spec.HostConfig.SecurityOpt,['no-new-privileges']);assert.ok(!spec.HostConfig.Privileged&&!spec.HostConfig.PidMode&&!spec.HostConfig.PortBindings);
  for(const port of [5554,5555,5556,8554,8555,18889])assert.ok(PACKET_FILTER.includes('port '+port));
  assert.throws(()=>packetCaptureSpec('image:latest','b'.repeat(64),'session-1234','agent','c'.repeat(32)));
});
test('capture cleanup refuses mismatched ownership or network namespaces',async()=>{
  let deleted=0;
  const docker={request:async(method)=>{if(method==='GET')return [{Id:'capture'}];deleted++;},inspect:async()=>({Id:'capture',Config:{Labels:{'remote-device-farm.capture':'true','remote-device-farm.session':'other','remote-device-farm.agent':'agent','remote-device-farm.capture.parent':'parent'}},HostConfig:{NetworkMode:'host'}})};
  await assert.rejects(removePacketCaptures(docker,'session-1234','agent'));assert.equal(deleted,0);
  docker.inspect=async()=>({Id:'capture',Config:{Labels:{'remote-device-farm.capture':'true','remote-device-farm.session':'session-1234','remote-device-farm.agent':'agent','remote-device-farm.capture.parent':'parent'}},HostConfig:{NetworkMode:'container:parent'}});
  await removePacketCaptures(docker,'session-1234','agent');assert.equal(deleted,1);
});
