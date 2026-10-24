import test from 'node:test';
import assert from 'node:assert/strict';
import { UiHierarchy, findElements, parseHierarchy, validateSelector } from './ui-hierarchy.mjs';
const node = (text, extra = '') => '<node text="' + text + '" enabled="true" bounds="[10,20][110,80]" ' + extra + '/>';
const xml = nodes => '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">' + nodes + '</hierarchy>';

test('bounded UI XML preserves entities, hierarchy and redacts password values', () => {
  const tree = parseHierarchy(xml('<node text="Container">' + node('Войти &amp; OK', 'resource-id="app:id/login"') + node('secret', 'password="true" content-desc="secret"') + '</node>'));
  assert.equal(tree.nodes[1].text, 'Войти & OK');
  assert.equal(tree.nodes[1].parentId, 0);
  assert.equal(tree.nodes[2].text, '');
  assert.equal(tree.nodes[2].description, '');
  assert.equal(findElements(tree, { resourceId: 'app:id/login' }).length, 1);
  assert.equal(findElements(tree, { text: 'Войти', exact: false }).length, 1);
  for (const invalid of ['', xml(node('a')).replace('</hierarchy>', ''), '<!DOCTYPE x>' + xml(node('a')), xml(node('a').repeat(2001)), xml('<script/>')]) assert.throws(() => parseHierarchy(invalid));
  for (const invalid of [{}, { text: '' }, { text: 'a', xpath: 'x' }, { text: 'a', index: -1 }]) assert.throws(() => validateSelector(invalid));
});
test('semantic tap rejects ambiguity/disabled bounds and uses a fresh selected device tree', async () => {
  let data = xml(node('Sign in') + node('Sign in'));
  const calls = [];
  const ui = new UiHierarchy({ run: async (serial, argv) => { calls.push({ serial, argv }); return { exitCode: 0, stdout: argv[0] === 'exec-out' ? data : '' }; } });
  await assert.rejects(ui.tap('selected-device', { text: 'Sign in' }), /Several/);
  assert.ok(!calls.some(c => c.argv.includes('tap')));
  const tapped = await ui.tap('selected-device', { text: 'Sign in', index: 1 });
  assert.equal(tapped.tapped, true);
  assert.deepEqual(calls.at(-1), { serial: 'selected-device', argv: ['shell', 'input', 'tap', '60', '50'] });
  data = xml(node('Sign in', 'password="true"'));
  await assert.rejects(ui.tap('selected-device', { text: 'Sign in' }), /No matching/);
  assert.ok(calls.some(c => c.argv[1] === 'rm' && /^\/data\/local\/tmp\/rdf-ui-[a-f0-9-]+\.xml$/.test(c.argv[3])));
});
test('UI reads reject concurrent dumps and remove temporary data after failure', async () => {
  let finish;
  const calls = [];
  const ui = new UiHierarchy({ run: async (_serial, argv) => {
    calls.push(argv);
    if (argv[1] === 'uiautomator') return new Promise(resolve => { finish = resolve; });
    return { exitCode: 1, stdout: '' };
  } });
  const first = ui.read('device');
  await assert.rejects(ui.read('device'), /already running/);
  finish({ exitCode: 1, stdout: '' });
  await assert.rejects(first, /Could not read/);
  assert.equal(ui.pending.size, 0);
  assert.equal(calls.at(-1)[1], 'rm');
});

test('a successful exit with a null root retries only the read and never replays a tap', async () => {
  let dumps=0,taps=0;
  const ui=new UiHierarchy({run:async(_serial,argv)=>{
    if(argv[1]==='uiautomator'){dumps++;return {exitCode:0,stdout:'',stderr:dumps===1?'ERROR: null root node returned by UiTestAutomationBridge.':''};}
    if(argv[0]==='exec-out')return {exitCode:0,stdout:xml(node('Tap once'))};
    if(argv.includes('tap'))taps++;
    return {exitCode:0,stdout:''};
  }});
  const result=await ui.tap('device',{text:'Tap once'});assert.equal(result.tapped,true);assert.equal(dumps,2);assert.equal(taps,1);assert.equal(ui.pending.size,0);
});
