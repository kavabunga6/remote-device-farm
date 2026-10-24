import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runProcess } from './adb.mjs';
test('the real HTTP proxy streams requests, omits credentials and tunnels CONNECT', async () => {
  const source = fileURLToPath(new URL('./network-proxy.py', import.meta.url));
  const script = [
    'import importlib.util,http.client,http.server,json,socket,socketserver,threading',
    'spec=importlib.util.spec_from_file_location("proxy",'+JSON.stringify(source)+'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'm.capture.start()',
    'class Origin(http.server.BaseHTTPRequestHandler):',
    ' def do_POST(self):',
    '  body=self.rfile.read(int(self.headers["Content-Length"])); self.send_response(201); self.send_header("Content-Type","text/plain"); self.send_header("Set-Cookie","private=secret"); self.end_headers(); self.wfile.write(body)',
    ' def log_message(self,*_): pass',
    'origin=http.server.HTTPServer(("127.0.0.1",0),Origin); threading.Thread(target=origin.serve_forever,daemon=True).start()',
    'proxy=m.Threaded(("127.0.0.1",0),m.Handler); threading.Thread(target=proxy.serve_forever,daemon=True).start()',
    'conn=http.client.HTTPConnection("127.0.0.1",proxy.server_port); conn.request("POST","http://127.0.0.1:%d/path?token=secret"%origin.server_port,b"hello",{"Authorization":"Bearer secret","Cookie":"private=secret"}); response=conn.getresponse(); assert response.status==201; assert response.read()==b"hello"; conn.close()',
    'class Echo(socketserver.BaseRequestHandler):',
    ' def handle(self): self.request.sendall(self.request.recv(4))',
    'echo=socketserver.TCPServer(("127.0.0.1",0),Echo); threading.Thread(target=echo.serve_forever,daemon=True).start()',
    'conn=http.client.HTTPConnection("127.0.0.1",proxy.server_port); conn.set_tunnel("127.0.0.1",echo.server_address[1]); conn.connect(); conn.sock.sendall(b"ping"); assert conn.sock.recv(4)==b"ping"; conn.close()',
    'import time; time.sleep(.1); print(json.dumps(m.status())); proxy.shutdown(); origin.shutdown(); echo.shutdown()',
  ].join('\n');
  const result = await runProcess(process.platform === 'win32' ? 'py' : 'python3', [...(process.platform === 'win32' ? ['-3', '-X', 'utf8'] : []), '-c', script], { timeoutMs: 15000 });
  assert.equal(result.exitCode, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0].status, 201);
  assert.equal(state.entries[1].method, 'CONNECT');
  assert.ok(!JSON.stringify(state).includes('secret'));
});

test('the internal inspector controller requires its private per-process credential', async()=>{
  const source=fileURLToPath(new URL('./network-proxy.py',import.meta.url));
  const script=[
    'import importlib.util,http.client,http.server,threading',
    'spec=importlib.util.spec_from_file_location("proxy",'+JSON.stringify(source)+');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)',
    'server=http.server.HTTPServer(("127.0.0.1",0),m.Control);m.admin=server;t=threading.Thread(target=server.serve_forever,daemon=True);t.start()',
    'def request(path,token=None):',
    ' c=http.client.HTTPConnection("127.0.0.1",server.server_port);c.request("GET",path,headers={} if token is None else {"X-RDF-Control":token});r=c.getresponse();status=r.status;r.read();c.close();return status',
    'assert request("/status")==403',
    'assert request("/status",chr(233)*64)==403',
    'assert request("/start?pcap=0&bodies=1","incorrect")==403',
    'assert not m.capture.recording',
    'assert request("/start?pcap=0&bodies=0",m.CONTROL_TOKEN)==200',
    'assert request("/shutdown",m.CONTROL_TOKEN)==409',
    'assert request("/stop",m.CONTROL_TOKEN)==200',
    'assert request("/shutdown",m.CONTROL_TOKEN)==200',
    't.join(2);assert not t.is_alive();server.server_close()',
  ].join('\n');
  const result=await runProcess(process.platform==='win32'?'py':'python3',[...(process.platform==='win32'?['-3','-X','utf8']:[]),'-c',script],{timeoutMs:15000});
  assert.equal(result.exitCode,0,result.stderr);
});
