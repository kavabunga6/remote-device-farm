import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundle=await build({entryPoints:['src/request-deadline.ts','src/polling-task.ts'],bundle:true,write:false,platform:'node',format:'esm',outdir:'out',logLevel:'silent'});
const modules=await Promise.all(bundle.outputFiles.map(file=>import('data:text/javascript;base64,'+Buffer.from(file.contents).toString('base64'))));
const {withRequestDeadline,RequestTimeoutError}=modules.find(module=>module.withRequestDeadline);
const {createPollingTask}=modules.find(module=>module.createPollingTask);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};

test('a stalled fetch or response body has a deadline even when its adapter ignores abort',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 let signal;
 const pending=withRequestDeadline(current=>{signal=current;return new Promise(()=>{});},{timeoutMs:120000});
 await Promise.resolve();
 context.mock.timers.tick(120000);
 await assert.rejects(pending,RequestTimeoutError);
 assert.equal(signal.aborted,true);
});

test('external cancellation is preserved and a completed request removes its timer/listeners',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const owner=new AbortController(),cause=new Error('cancelled owner');let signal;
 const pending=withRequestDeadline(current=>{signal=current;return new Promise(()=>{});},{signal:owner.signal});
 await Promise.resolve();owner.abort(cause);await assert.rejects(pending,error=>error===cause);
 assert.equal(signal.aborted,true);
 const successOwner=new AbortController();
 const value=await withRequestDeadline(async current=>{signal=current;return 42;},{signal:successOwner.signal,timeoutMs:20});
 assert.equal(value,42);successOwner.abort();context.mock.timers.tick(1000);assert.equal(signal.aborted,false);
});

test('an already cancelled owner starts no network operation',async()=>{
 const owner=new AbortController();owner.abort();
 let calls=0;
 await assert.rejects(withRequestDeadline(async()=>{calls++;return 1;},{signal:owner.signal}));
 assert.equal(calls,0);
});

test('slow polling is single-flight and refresh discards an older result',async()=>{
 const reads=[],results=[];
 const task=createPollingTask(signal=>{const item=deferred();reads.push({signal,...item});return item.promise;},value=>results.push(value));
 const first=task.run();assert.equal(task.run(),first);await Promise.resolve();assert.equal(reads.length,1);
 const second=task.refresh();await Promise.resolve();assert.equal(reads.length,2);assert.equal(reads[0].signal.aborted,true);
 reads[1].resolve('new');await second;reads[0].resolve('stale');await first;
 assert.deepEqual(results,['new']);task.dispose();
});

test('poll errors recover and disposal cannot publish delayed data or start another read',async()=>{
 const reads=[],results=[];
 const task=createPollingTask(signal=>{const item=deferred();reads.push({signal,...item});return item.promise;},value=>results.push(value));
 const first=task.run();await Promise.resolve();reads[0].reject(new Error('offline'));await first;
 const next=task.run();await Promise.resolve();task.dispose();assert.equal(reads[1].signal.aborted,true);
 reads[1].resolve('private old account');await next;await task.run();
 assert.equal(reads.length,2);assert.deepEqual(results,[]);
});
