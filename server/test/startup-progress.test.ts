import test from 'node:test';
import assert from 'node:assert/strict';
import { startupFailureMessage } from '../src/startup-progress.js';

test('an exited emulator produces a fixed public startup error without exposing agent details', () => {
  const progress = { stage: 'booting', updatedAt: new Date().toISOString() };
  assert.equal(startupFailureMessage(progress, new Error('Emulator container stopped before Android finished booting')),
    'Эмулятор завершился до загрузки Android. Проверьте образ и параметры запуска.');
  for (const error of [new Error('private registry token'), new Error('Emulator container stopped before Android finished booting secret'), 'private logs', null]) {
    assert.equal(startupFailureMessage(progress, error), 'Android не завершил загрузку. Проверьте ресурсы профиля и повторите запуск.');
  }
});


test('a GPU capability lost after reservation has a clear fixed public explanation', () => {
  const message = 'GPU на узле стал недоступен. Выберите другой узел или запустите устройство без ускорения GPU.';
  for (const stage of ['creating', 'booting']) {
    const progress = { stage, updatedAt: new Date().toISOString() };
    assert.equal(startupFailureMessage(progress, new Error('Requested GPU backend is not available on this node')), message);
    assert.notEqual(startupFailureMessage(progress, new Error('Requested GPU backend is not available on this node secret')), message);
  }
  assert.equal(startupFailureMessage(null, new Error('Requested GPU backend is not available on this node')), message);
});


test('unsupported resource transports return fixed explanations without raw image details', () => {
  for (const [field, env, message] of [
    ['memory', 'MEMORY', 'Этот образ не принимает выбранный объём памяти Android. Администратору нужно настроить передачу параметра памяти в профиле.'],
    ['cores', 'CORES', 'Этот образ не принимает выбранное число ядер Android. Администратору нужно настроить передачу параметра ядер в профиле.'],
  ]) {
    const reason = `Guest ${field} cannot be applied by this image profile; enable the ${field} farm flag or declare ${env}`;
    assert.equal(startupFailureMessage(null, new Error(reason)), message);
    assert.notEqual(startupFailureMessage(null, new Error(reason + ' private logs')), message);
  }
});
