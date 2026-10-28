import {execInContainer} from './emu-console.mjs';
import {agentMessage} from './messages.mjs';
const PREFIX='remote-device-farm.';
const failed=()=>{throw new Error(agentMessage('networkInspector.failed'));};
const missing=e=>/No such container|404/.test(String(e.message));
const owned=(c,session,agent)=>c.Config?.Labels?.[PREFIX+'capture']==='true' && c.Config.Labels[PREFIX+'session']===session && c.Config.Labels[PREFIX+'agent']===agent && c.HostConfig?.NetworkMode==='container:'+c.Config.Labels[PREFIX+'capture.parent'];
export function packetCaptureSpec(image,parent,session,agent,captureId) {
  if(!/^sha256:[a-f0-9]{64}$/.test(image)||!/^[a-f0-9]{64}$/.test(parent)||!/^[A-Za-z0-9-]{8,64}$/.test(session)||!/^[A-Za-z0-9_-]{1,64}$/.test(agent)||!/^[a-f0-9]{32}$/.test(captureId))failed();
  return {Image:image,User:'0:0',Entrypoint:['node','--max-old-space-size=32','/app/src/packet-capture-worker.mjs'],Cmd:['serve'],Env:['LANG=C'],
    Labels:{[PREFIX+'capture']:'true',[PREFIX+'capture.parent']:parent,[PREFIX+'session']:session,[PREFIX+'agent']:agent,[PREFIX+'capture.id']:captureId},
    HostConfig:{NetworkMode:'container:'+parent,ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:['NET_RAW','SETGID'],SecurityOpt:['no-new-privileges'],
      Memory:128*1024*1024,MemorySwap:128*1024*1024,NanoCpus:250000000,PidsLimit:32,RestartPolicy:{Name:'no'},
      LogConfig:{Type:'none'},Tmpfs:{'/capture':'rw,nosuid,nodev,noexec,size=40m,mode=0700'},Binds:[]}};
}
export async function removePacketCaptures(docker,session,agent) {
  const filters=JSON.stringify({label:[PREFIX+'capture=true',PREFIX+'session='+session,PREFIX+'agent='+agent]});
  const items=await docker.request('GET','/containers/json?all=true&filters='+encodeURIComponent(filters));
  for(const item of items){
    let c;try{c=await docker.inspect(item.Id);}catch(e){if(missing(e))continue;throw e;}
    if(!owned(c,session,agent))failed();
    try{await docker.request('DELETE','/containers/'+encodeURIComponent(c.Id)+'?force=true&v=true');}catch(e){if(!missing(e))throw e;}
  }
}
export class PacketCapture {
  constructor(docker,{agentId,selfContainerId,image}={}){this.docker=docker;this.agentId=agentId;this.selfContainerId=selfContainerId;this.image=image;}
  name(session){return 'rdf-pcap-'+session;}
  async container(session,captureId){
    let c;try{c=await this.docker.inspect(this.name(session));}catch(e){if(missing(e))return null;throw e;}
    if(!owned(c,session,this.agentId)||(captureId&&c.Config.Labels[PREFIX+'capture.id']!==captureId))failed();return c;
  }
  async available(){try{await this.imageId();return true;}catch{return false;}}
  async imageId(){
    let image=this.image;
    if(!image){const self=await this.docker.inspect(this.selfContainerId);image=self.Image;}
    const detail=await this.docker.request('GET','/images/'+encodeURIComponent(image)+'/json');
    if(detail.Config?.Labels?.[PREFIX+'packet-capture']!=='1'||Object.keys(detail.Config?.Volumes??{}).length)throw new Error(agentMessage('networkInspector.unavailable'));
    return detail.Id;
  }
  async call(c,action,offset){
    if(!c?.State?.Running)failed();
    const r=await execInContainer(this.docker,c.Id,['node','/app/src/packet-capture-worker.mjs',action,...(offset===undefined?[]:[String(offset)])],[],5000,1024*1024);
    if(r.exitCode||r.truncated)failed();return JSON.parse(r.stdout);
  }
  async start(parent,session,captureId){
    const image=await this.imageId();const old=await this.container(session);
    if(old){const state=await this.call(old,'status');if(['starting','recording','finalizing'].includes(state.pcapState))failed();await removePacketCaptures(this.docker,session,this.agentId);}
    const body=packetCaptureSpec(image,parent,session,this.agentId,captureId);
    // A deterministic name and labels let recovery reconcile uncertain create/start replies.
    const created=await this.docker.request('POST','/containers/create?name='+encodeURIComponent(this.name(session)),body);
    if(!/^[a-f0-9]{64}$/.test(created?.Id??''))failed();
    await this.docker.request('POST','/containers/'+created.Id+'/start');
    for(let i=0;i<20;i++){
      const c=await this.container(session,captureId);let state;try{state=await this.call(c,'status');}catch{await new Promise(r=>setTimeout(r,100));continue;}
      if(state.pcapState==='recording')return state;if(state.pcapState==='error')failed();await new Promise(r=>setTimeout(r,100));
    }failed();
  }
  async status(session,captureId){const c=await this.container(session,captureId);return c?.State?.Running?this.call(c,'status'):{pcapState:'error',pcapBytes:0};}
  async stop(session,captureId){
    const c=await this.container(session,captureId);if(!c)return {pcapState:'stopped',pcapBytes:0};
    if(!c.State?.Running){await removePacketCaptures(this.docker,session,this.agentId);return {pcapState:'stopped',pcapBytes:0};}
    let state=await this.call(c,'stop');for(let i=0;i<20&&['starting','recording','finalizing'].includes(state.pcapState);i++){await new Promise(r=>setTimeout(r,100));state=await this.call(c,'status');}return state;
  }
  async read(session,captureId,offset){return this.call(await this.container(session,captureId),'read',offset);}
}
