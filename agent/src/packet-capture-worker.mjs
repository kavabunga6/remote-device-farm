// Runs only in a bounded, session-local network namespace. Raw bytes never enter Docker logs.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const FILE = '/capture/traffic.pcap', STATE = '/capture/state.json', STOP = '/capture/stop';
export const PACKET_FILTER = 'not (tcp port 5554 or tcp port 5555 or tcp port 5556 or tcp port 8554 or tcp port 8555 or tcp port 18889)';
export class PcapWriter {
  constructor(write, onLimit, maximum = 30 * 1024 * 1024) { this.write = write; this.onLimit = onLimit; this.maximum = maximum; this.pending = Buffer.alloc(0); this.bytes = 0; this.records = 0; this.ended = false; }
  accept(chunk) {
    if (this.ended) return;
    if (chunk.length > 256 * 1024) throw new Error('pcap_chunk_size');
    this.pending = Buffer.concat([this.pending, chunk]);
    if (!this.bytes) {
      if (this.pending.length < 24) return;
      const magic = this.pending.subarray(0, 4).toString('hex');
      if (!['d4c3b2a1','a1b2c3d4','4d3cb2a1','a1b23c4d'].includes(magic)) throw new Error('pcap_header');
      this.little = ['d4c3b2a1','4d3cb2a1'].includes(magic);
      if (this.number(16) > 65535) throw new Error('pcap_snapshot');
      this.write(this.pending.subarray(0,24));this.bytes = 24;this.pending = this.pending.subarray(24);
    }
    while (this.pending.length >= 16) {
      const size = this.number(8), original = this.number(12);
      if (size > 65535 || original < size) throw new Error('pcap_packet_size');
      if (this.pending.length < size + 16) break;
      if (this.bytes + size + 16 > this.maximum) { this.ended = true;this.pending = Buffer.alloc(0);this.onLimit();return; }
      this.write(this.pending.subarray(0, size + 16));this.bytes += size + 16;this.records++;this.pending = this.pending.subarray(size + 16);
    }
  }
  number(offset) { return this.little ? this.pending.readUInt32LE(offset) : this.pending.readUInt32BE(offset); }
}

function save(state) {
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(state), {mode:0o600});fs.renameSync(STATE + '.tmp', STATE);
}
function serve() {
  process.umask(0o077);
  const fd = fs.openSync(FILE, 'wx', 0o600);
  const state = {pcapState:'starting',pcapBytes:0,packetCount:0,stopReason:null,startedAt:Date.now()};
  let requested = false, exiting = false, killTimer;
  const child = spawn('tcpdump', ['-nn','-p','-i','any','-s','65535','-U','-Z','root','-w','-',PACKET_FILTER], {stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,LANG:'C'}});
  const stop = reason => {
    if (requested) return; requested = true;state.stopReason = reason;state.pcapState = 'finalizing';save(state);
    child.kill('SIGINT');killTimer = setTimeout(()=>child.kill('SIGKILL'),2000);killTimer.unref();
  };
  const writer = new PcapWriter(bytes => fs.writeSync(fd,bytes), ()=>stop('size_limit'));
  const finish = (code, signal) => {
    clearInterval(watch);clearTimeout(killTimer);fs.closeSync(fd);
    state.pcapBytes = writer.bytes;state.packetCount = writer.records;state.exitCode=code;state.exitSignal=signal;
    state.pcapState = writer.bytes >= 24 && (code === 0 || signal === 'SIGINT') ? 'stopped' : 'error';save(state);
    if (exiting) process.exit(state.pcapState === 'stopped' ? 0 : 1);
  };
  child.once('spawn',()=>{state.pcapState='recording';save(state);});
  child.stdout.on('data', bytes => { try { writer.accept(bytes); } catch { stop('capture_error'); } });
  child.once('error',()=>stop('capture_error'));
  child.once('close',finish);
  const watch = setInterval(()=>{
    state.pcapBytes=writer.bytes;state.packetCount=writer.records;save(state);
    if (fs.existsSync(STOP)) stop('manual');
    else if (Date.now()-state.startedAt>=600000) stop('time_limit');
  },250);
  // Keep the bounded tmpfs and export available until the device is released.
  const keep = setInterval(()=>{},60000);
  process.on('SIGTERM',()=>{exiting=true;clearInterval(keep);if (['stopped','error'].includes(state.pcapState)) process.exit(0);else stop('recovery');});
  save(state);
}
function command(action, offset) {
  if (action === 'stop') fs.writeFileSync(STOP,'',{mode:0o600});
  if (action === 'status' || action === 'stop') {process.stdout.write(fs.readFileSync(STATE));return;}
  if (action !== 'read' || !Number.isSafeInteger(offset) || offset<0 || offset>40*1024*1024) throw new Error('pcap_command');
  const state=JSON.parse(fs.readFileSync(STATE));if(state.pcapState!=='stopped')throw new Error('pcap_not_stopped');
  const fd=fs.openSync(FILE,'r');try{const size=fs.fstatSync(fd).size;const data=Buffer.alloc(256*1024);const count=fs.readSync(fd,data,0,data.length,offset);console.log(JSON.stringify({contentBase64:data.subarray(0,count).toString('base64'),offset,size}));}finally{fs.closeSync(fd);}
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2]==='serve') serve();else command(process.argv[2],Number(process.argv[3]));
}
