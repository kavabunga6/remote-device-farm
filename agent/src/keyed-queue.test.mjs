import test from 'node:test';
import assert from 'node:assert/strict';
import { runKeyed } from './keyed-queue.mjs';

test('resource queues serialize same keys, survive failure and release entries', async () => {
 const map=new Map(), seen=[]; let unlock;
 const first=runKeyed(map,'a',()=>new Promise(resolve=>{unlock=resolve;seen.push('first');}));
 const second=runKeyed(map,'a',()=>{seen.push('second');throw new Error('expected');});
 const rejection=assert.rejects(second,/expected/);
 const third=runKeyed(map,'a',()=>seen.push('third'));
 await runKeyed(map,'b',()=>seen.push('independent'));
 assert.deepEqual(seen,['first','independent']);
 unlock();await first;await rejection;await third;
 assert.deepEqual(seen,['first','independent','second','third']);
 assert.equal(map.size,0);
});
