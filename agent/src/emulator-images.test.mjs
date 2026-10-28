import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageJobStore } from './emulator-image-job-store.mjs';
import { EmulatorImages, buildProgress, hostAbi, tarArchive } from './emulator-images.mjs';

const evidence = { version: 1, imageId:'sha256:test-image', checks: { off: Object.fromEntries(['bootCompleted','adbSecure','unauthorizedAdb','rendererVerified','deviceVerified','resourcesVerified'].map(k=>[k,true])) } };
const testedImages = options => new EmulatorImages({ verify: async()=>structuredClone(evidence), builder: { build: async (tag, args, { contextTar, target, onLine, signal }) => {
  const query = new URLSearchParams({ t: tag, rm: '1', forcerm: '1', buildargs: JSON.stringify(args), ...(target ? { target } : {}) });
  await options.docker.request('POST', '/build?' + query, undefined, { rawBody: contextTar, contentType: 'application/x-tar', signal, onJsonEvent: event => { for (const line of String(event.stream ?? '').split(/\r?\n/)) if (line.trim()) onLine(line.trim()); } });
} }, ...options });

const list = readFileSync(new URL('./fixtures/sdkmanager-list.txt', import.meta.url), 'utf8');

function fakeDocker({ builtLabels = [], failBuild = null } = {}) {
  const calls = [];
  const images = new Set();
  return { calls, images, async request(method, path, body, options = {}) {
    calls.push({ method, path, body, options });
    if (path.startsWith('/images/rdf-emulator-tools')) { if (images.has('tools')) return {}; throw new Error('No such image'); }
    if (path.startsWith('/build')) {
      const query = new URLSearchParams(path.split('?')[1]);
      if (query.get('target') === 'tools') { images.add('tools'); return null; }
      const args = JSON.parse(query.get('buildargs'));
      for (const line of ['Step 1/12 : FROM ubuntu', '[=====    ] 42% Downloading x86_64-34_r14.zip', 'Step 9/12 : COPY rdf-emulator.sh']) options.onJsonEvent?.({ stream: line + '\n' });
      if (failBuild && args.SYSTEM_IMAGE === failBuild) throw new Error('network unreachable');
      builtLabels.push(args.SYSTEM_IMAGE);
      return null;
    }
    if (path === '/containers/create') return { Id: 'tools1' };
    if (path.endsWith('/wait')) return { StatusCode: 0 };
    if (path.includes('/logs')) return Buffer.from(list);
    if (path.includes('/push')) {
      options.pushes = (options.pushes ?? 0) + 1;
      options.onJsonEvent?.({ status: 'Pushed' });
      options.onJsonEvent?.({ aux: { Digest: 'sha256:' + 'a'.repeat(64), Size: 1 } });
      return null;
    }
    if (path.startsWith('/images/') && path.endsWith('/json')) return { Id:'sha256:test-image', Size: 3 * 1048576 };
    if (path.startsWith('/images/json')) return builtLabels.map((name, index) => ({ RepoTags: ['rdf-emulator:built-' + index], Size: 3 * 1048576, Labels: { 'remote-device-farm.system-image': name } }));
    return {};
  } };
}

test('the build context is a valid tar of the bundled image files', async () => {
  const images = testedImages({ docker: fakeDocker() });
  const { tar, hash } = await images.context();
  const listing = execFileSync('tar', ['-tvf', '-'], { input: tar, encoding: 'utf8' });
  for (const name of ['Dockerfile', 'rdf-emulator.sh', 'adb-auth-gate.sh', 'secure-ramdisk.py', 'ramdisk.py', 'xorg.conf']) assert.match(listing, new RegExp(name.replace('.', '\\.')));
  assert.match(listing, /-rwxr-xr-x .* rdf-emulator\.sh/);
  assert.match(listing, /-rwxr-xr-x .* adb-auth-gate\.sh/);
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.throws(() => tarArchive([{ name: '../x', mode: 0o644, data: Buffer.alloc(0) }]));
});

test('progress follows Docker steps and sdkmanager downloads', () => {
  let progress = buildProgress('Step 3/12 : RUN sdkmanager');
  assert.deepEqual(progress, { step: 3, steps: 12, percent: null });
  progress = buildProgress('[====   ] 57% Downloading system image', progress);
  assert.deepEqual(progress, { step: 3, steps: 12, percent: 57 });
  assert.equal(hostAbi('x64'), 'x86_64');
  assert.equal(hostAbi('arm64'), 'arm64-v8a');
});

test('catalog lists host-ABI images and caches the sdkmanager run', async () => {
  const docker = fakeDocker();
  const images = testedImages({ docker, abi: 'x86_64' });
  const catalog = await images.catalog();
  assert.equal(catalog.abi, 'x86_64');
  const apis30 = catalog.images.find(image => image.package === 'system-images;android-30;google_apis;x86_64');
  assert.equal(apis30.tag, '30-google_apis-x86_64');
  assert.ok(catalog.images.some(image => image.device === 'tv' && image.flavor === 'aosp'));
  assert.ok(!catalog.images.some(image => image.abi === 'arm64-v8a'));
  const toolBuilds = docker.calls.filter(call => call.path.startsWith('/build')).length;
  await images.catalog();
  assert.equal(docker.calls.filter(call => call.path === '/containers/create').length, 1, 'cached within an hour');
  assert.equal(docker.calls.filter(call => call.path.startsWith('/build')).length, toolBuilds);
  assert.ok(docker.calls.some(call => call.method === 'DELETE' && call.path.startsWith('/containers/tools1')));
});

test('builds run one at a time, report progress and failures, and carry the profiles to create', async () => {
  const docker = fakeDocker({ failBuild: 'system-images;android-30;android-tv;x86' });
  const images = testedImages({ docker, abi: 'x86_64' });
  const target = { repository: 'farm.example.com/rdf-emulator', auth: { username: 'rdf', password: 'push-token', serveraddress: 'farm.example.com' } };
  assert.throws(() => images.enqueue(['system-images;android-34;google_apis_playstore;x86_64'], target), /catalog first/);
  await images.catalog();
  assert.throws(() => images.enqueue(['system-images;android-34;evil;x86_64'], target), /Unknown system image/);
  assert.throws(() => images.enqueue(['system-images;android-34;google_apis_playstore;x86_64']), /target/);
  const { jobs } = images.enqueue(['system-images;android-34;google_apis_playstore;x86_64', 'system-images;android-30;android-tv;x86'], target);
  assert.equal(jobs.length, 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  const [tv, play] = images.jobList();
  assert.equal(play.state, 'done');
  assert.deepEqual(play.progress, { step: 9, steps: 12, percent: null }, 'a new build step resets the download percent');
  assert.ok(play.profiles.some(profile => profile.android.resolution === '2560x1600'), 'phone image also offers a tablet profile');
  assert.equal(play.profiles[0].image.repository, 'farm.example.com/rdf-emulator');
  assert.equal(play.digest, 'sha256:' + 'a'.repeat(64));
  assert.equal(play.sizeMb, 3);
  assert.equal(play.auth, undefined, 'credentials never leave the agent in job lists');
  const push = docker.calls.find(call => call.path.includes('/push'));
  assert.match(push.path, /farm\.example\.com%2Frdf-emulator\/push\?tag=34-google_apis_playstore-x86_64/);
  assert.equal(JSON.parse(Buffer.from(push.options.headers['X-Registry-Auth'], 'base64url')).password, 'push-token');
  assert.equal(tv.state, 'failed');
  assert.match(tv.error, /network unreachable/);
  const build = docker.calls.find(call => call.path.startsWith('/build') && call.path.includes('playstore'));
  assert.equal(build.options.contentType, 'application/x-tar');
  assert.match(decodeURIComponent(build.path), /t=farm\.example\.com\/rdf-emulator:34-google_apis_playstore-x86_64/);
});

const buildTarget = { repository: 'farm.example.com/rdf-emulator', auth: { username: 'rdf', password: 'private-push-token', serveraddress: 'farm.example.com' } };
const buildPackage = 'system-images;android-34;google_apis_playstore;x86_64';
const waitForJobs = async images => {
  for (let attempt = 0; attempt < 100 && images.jobList().some(job => ['queued', 'building', 'validating', 'pushing', 'cancelling'].includes(job.state)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(images.jobList().every(job => ['done', 'failed', 'cancelled'].includes(job.state)));
};

test('build results survive restart and in-flight records are explicitly failed without persisting credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rdf-image-jobs-'));
  try {
    const images = testedImages({ docker: fakeDocker(), stateDir: directory });
    await images.catalog();
    images.enqueue([buildPackage], buildTarget);
    await waitForJobs(images);
    const done = images.jobList()[0];
    const stored = readFileSync(join(directory, 'jobs.json'), 'utf8');
    assert.ok(!stored.includes('private-push-token'));
    assert.ok(!stored.includes('"auth"'));
    const store = new ImageJobStore(directory);
    store.write([done, ...['queued', 'building', 'validating', 'pushing'].map((state, index) => ({ ...done, id: 'interrupted-' + index, state, digest: null, auth: buildTarget.auth }))]);
    const restored = testedImages({ docker: fakeDocker(), stateDir: directory });
    assert.equal(restored.jobList()[0].state, 'done');
    assert.equal(restored.jobList()[0].digest, done.digest);
    for (const job of restored.jobList().slice(1)) {
      assert.equal(job.state, 'failed');
      assert.match(job.error, /interrupted.*restart/);
      assert.ok(job.finishedAt);
    }
    assert.ok(new ImageJobStore(directory).read().slice(1).every(job => job.state === 'failed'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a corrupt ledger fails visibly instead of silently discarding jobs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rdf-image-jobs-'));
  try {
    writeFileSync(join(directory, 'jobs.json'), '{broken');
    assert.throws(() => testedImages({ docker: fakeDocker(), stateDir: directory }), SyntaxError);
    assert.equal(readFileSync(join(directory, 'jobs.json'), 'utf8'), '{broken');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('queue admission is atomic and cannot evict active or unacknowledged jobs', async () => {
  const images = testedImages({ docker: fakeDocker() });
  await images.catalog();
  assert.throws(() => images.enqueue([buildPackage, 'not-in-catalog'], buildTarget), /Unknown/);
  assert.equal(images.jobList().length, 0, 'valid prefixes of a rejected batch are not accepted');
  images.jobs = Array.from({ length: 50 }, (_, index) => ({ id: 'retained-' + index, state: 'done', package: 'retained', image: 'image', log: [], profiles: [] }));
  assert.throws(() => images.enqueue([buildPackage], buildTarget), /queue is full/);
  assert.equal(images.jobList().length, 50);
  images.acknowledge(images.jobs.map(job => job.id));
  images.enqueue([buildPackage], buildTarget);
  await waitForJobs(images);
  assert.equal(images.jobList().length, 50);
  assert.equal(images.jobList()[0].state, 'done');
});

test('queue rejects acceptance when durable storage is unavailable', async () => {
  const docker = fakeDocker();
  const images = testedImages({ docker, store: { read: () => [], write: () => { throw new Error('disk full'); } } });
  await images.catalog();
  const before = docker.calls.length;
  assert.throws(() => images.enqueue([buildPackage], buildTarget), /disk full/);
  assert.equal(images.jobList().length, 0);
  assert.equal(docker.calls.length, before, 'a rejected request does not start building');
});

test('pushing builds are deduplicated for their repository', async () => {
  const images = testedImages({ docker: fakeDocker() });
  await images.catalog();
  images.jobs = [{ id: 'pushing-job', state: 'pushing', package: buildPackage, image: buildTarget.repository + ':34-google_apis_playstore-x86_64', log: [], profiles: [] }];
  const queued = images.enqueue([buildPackage], buildTarget);
  assert.equal(queued.jobs.length, 1);
  assert.equal(queued.jobs[0].id, 'pushing-job');
});


const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function controlledBuild(phase, { store } = {}) {
  const docker = fakeDocker();
  const request = docker.request.bind(docker);
  const entered = deferred(), release = deferred();
  docker.request = async (method, path, body, options = {}) => {
    const held = phase === 'build' ? path.startsWith('/build?') && !path.includes('target=tools')
      : phase === 'push' ? path.includes('/push?') : path.includes('farm.example.com') && path.endsWith('/json');
    if (held) {
      entered.resolve(options);
      await release.promise;
    }
    return request(method, path, body, options);
  };
  const images = testedImages({ docker, store });
  await images.catalog();
  const queued = images.enqueue([buildPackage, 'system-images;android-30;android-tv;x86'], buildTarget);
  const options = await entered.promise;
  const job = images.jobList().find(item => item.package === buildPackage);
  return { images, docker, job, options, release, queued };
}

test('queued cancellation is durable, needs no Docker call and leaves the active build untouched', async () => {
  const writes = [];
  const fixture = await controlledBuild('build', { store: { read: () => [], write: jobs => writes.push(JSON.parse(JSON.stringify(jobs))) } });
  const { images, docker, options, release } = fixture;
  const queued = images.jobList().find(job => job.state === 'queued');
  const before = docker.calls.length;
  const result = images.cancel(queued.id);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].state, 'cancelled');
  assert.ok(result.jobs[0].finishedAt);
  assert.equal(options.signal.aborted, false);
  assert.equal(docker.calls.length, before);
  assert.equal(writes.at(-1).find(job => job.id === queued.id).state, 'cancelled');
  images.acknowledge([queued.id]);
  assert.equal(writes.at(-1).find(job => job.id === queued.id).acknowledged, true);
  release.resolve();
  await waitForJobs(images);
  assert.equal(images.jobList().find(job => job.id === fixture.job.id).state, 'done');
  assert.equal(docker.calls.filter(call => call.path.startsWith('/build') && call.path.includes('android-tv')).length, 0);
});

for (const phase of ['build', 'push', 'inspect']) {
  test(`cancellation during ${phase} aborts the request and cannot race into done`, async () => {
    const { images, docker, job, options, release } = await controlledBuild(phase);
    const result = images.cancel(job.id);
    assert.equal(result.jobs[0].state, 'cancelling');
    assert.equal(options.signal.aborted, true);
    assert.equal(images.cancel(job.id).jobs[0].state, 'cancelling', 'repeat is idempotent');
    assert.equal(images.enqueue([buildPackage], buildTarget).jobs[0].id, job.id, 'cancelling retains queue ownership');
    assert.equal(images.jobList().find(item => item.id === job.id).finishedAt, undefined, 'do not claim completion before Docker request settles');
    // A transport might resolve concurrently with abort. The phase boundary must still prevent done.
    release.resolve();
    await waitForJobs(images);
    const cancelled = images.jobList().find(item => item.id === job.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.error, null);
    assert.ok(cancelled.finishedAt);
    assert.equal(images.cancel(job.id).jobs[0].state, 'cancelled');
    assert.equal(images.jobList().find(item => item.package.includes('android-tv')).state, 'done', 'next unrelated job still runs');
    if (phase === 'build') assert.ok(!docker.calls.some(call => call.path.includes('/push?') && call.path.includes('playstore')), 'cancelled build is never pushed');
    assert.ok(!docker.calls.some(call => call.method === 'DELETE' && !call.path.includes('tools1')), 'no global Docker cleanup');
  });
}

test('request rejection after cancellation is cancelled rather than failed', async () => {
  const { images, job, release } = await controlledBuild('build');
  images.cancel(job.id);
  release.reject(new Error('Docker API response aborted'));
  await waitForJobs(images);
  assert.equal(images.jobList().find(item => item.id === job.id).state, 'cancelled');
});

test('cancellation persistence failure does not abort an accepted build', async () => {
  let fail = false;
  const { images, job, options, release } = await controlledBuild('build', {
    store: { read: () => [], write: () => { if (fail) throw new Error('disk full'); } },
  });
  fail = true;
  assert.throws(() => images.cancel(job.id), /disk full/);
  assert.equal(options.signal.aborted, false);
  assert.equal(images.jobList().find(item => item.id === job.id).state, 'building');
  assert.equal(images.jobList().find(item => item.id === job.id).cancelRequestedAt, undefined);
  fail = false;
  release.resolve();
  await waitForJobs(images);
  assert.equal(images.jobList().find(item => item.id === job.id).state, 'done');
  assert.equal(images.cancel(job.id).jobs[0].state, 'done', 'completion wins if already recorded');
  assert.throws(() => images.cancel('unknown-job'), /not found/);
  assert.throws(() => images.cancel('../other'), /Invalid/);
});

test('restart preserves cancelled jobs and explicitly fails an unconfirmed cancellation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rdf-cancelled-jobs-'));
  try {
    const record = { package: buildPackage, image: buildTarget.repository + ':tag', profiles: [], log: [], cancelRequestedAt: '2026-01-01T00:00:00.000Z' };
    new ImageJobStore(directory).write([
      { ...record, id: 'cancelled-job', state: 'cancelled', finishedAt: record.cancelRequestedAt },
      { ...record, id: 'cancelling-job', state: 'cancelling' },
    ]);
    const images = testedImages({ docker: fakeDocker(), stateDir: directory });
    assert.equal(images.jobList()[0].state, 'cancelled');
    assert.equal(images.jobList()[1].state, 'failed');
    assert.match(images.jobList()[1].error, /cancellation interrupted.*termination could not be confirmed/);
    images.acknowledge(['cancelled-job', 'cancelling-job']);
    assert.ok(new ImageJobStore(directory).read().every(job => job.acknowledged));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('new artifacts require complete runtime evidence before any registry push', async () => {
  for(const proof of [null,{version:1,checks:{off:{bootCompleted:true}}},{...evidence,version:99}]) {
    const docker=fakeDocker();const images=testedImages({docker,verify:async()=>proof});
    await images.catalog();images.enqueue([buildPackage],buildTarget);await waitForJobs(images);
    assert.equal(images.jobList()[0].state,'failed');
    assert.equal(images.jobList()[0].errorCode,'image_invalid');
    assert.equal(images.jobList()[0].digest,null);
    assert.ok(!docker.calls.some(call=>call.path.includes('/push')));
  }
});

test('a build stays validating until the checker succeeds; cancellation never publishes it', async () => {
  const docker=fakeDocker();let entered;
  const checking=new Promise(resolve=>entered=resolve);
  const images=testedImages({docker,verify:async(_image,{signal})=>{
    entered();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  await images.catalog();const job=images.enqueue([buildPackage],buildTarget).jobs[0];
  await checking;
  assert.equal(images.jobList()[0].state,'validating');
  assert.ok(!docker.calls.some(call=>call.path.includes('/push')));
  assert.equal(images.enqueue([buildPackage],buildTarget).jobs[0].id,job.id,'validation is still an active build');
  images.cancel(job.id);await waitForJobs(images);
  assert.equal(images.jobList()[0].state,'cancelled');
  assert.ok(!docker.calls.some(call=>call.path.includes('/push')));
});

test('successful runtime evidence is persisted and only then pushed', async () => {
  const docker=fakeDocker();let checked=false;
  const request=docker.request.bind(docker);
  docker.request=async(method,path,...args)=>{if(path.includes('/push'))assert.equal(checked,true);return request(method,path,...args);};
  const directory=mkdtempSync(join(tmpdir(),'rdf-validated-build-'));
  try {
    const images=testedImages({docker,stateDir:directory,verify:async()=>{checked=true;return evidence;}});
    await images.catalog();images.enqueue([buildPackage],buildTarget);await waitForJobs(images);
    const job=images.jobList()[0];assert.equal(job.state,'done');assert.deepEqual(job.validation,evidence);
    assert.deepEqual(new ImageJobStore(directory).read()[0].validation,evidence);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('a changed local tag cannot publish another artifact after validation',async()=>{
  const docker=fakeDocker();const images=testedImages({docker,verify:async()=>({...evidence,imageId:'sha256:different'})});
  await images.catalog();images.enqueue([buildPackage],buildTarget);await waitForJobs(images);
  assert.equal(images.jobList()[0].state,'failed');assert.match(images.jobList()[0].error,/tag changed/);
  assert.ok(!docker.calls.some(call=>call.path.includes('/push')));
});
