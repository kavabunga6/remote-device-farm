import test from 'node:test';
import assert from 'node:assert/strict';
import {uiCommandError} from '../src/routes/ui-routes.js';
import {uiMessage} from '../src/messages.js';
test('UI failures have stable codes and never expose upstream paths or credentials',()=>{
  for(const language of ['ru','en']as const){
    const unavailable=uiCommandError(new Error(uiMessage('agent.ui.unavailable',{},language)));
    assert.equal(unavailable.status,503);assert.equal(unavailable.code,'device_ui_unavailable');
    const uncertain=uiCommandError(new Error(uiMessage('agent.ui.inputFailed',{},language)));
    assert.equal(uncertain.status,502);assert.equal(uncertain.code,'device_ui_input_unconfirmed');
  }
  const unknown=uiCommandError(new Error('private fixture path and credential'));
  assert.equal(unknown.status,502);assert.ok(!unknown.message.includes('private fixture'));
});
