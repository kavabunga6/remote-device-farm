import assert from 'node:assert/strict';
import test from 'node:test';
import { auditMessageSources, sourceProblems } from '../scripts/check-message-sources.mjs';

test('interface copy, server notices and agent message references stay external', () => {
  assert.deepEqual(auditMessageSources(), []);
});
test('the source guard catches text hidden in JSX expressions and attributes', () => {
  for (const source of [
    '<button>Delete user</button>', '<button>{"Delete user"}</button>',
    '<input placeholder={"Your login"}/>', '<span>{busy ? "Loading" : "Ready"}</span>',
    '<span>{`Loaded ${count} files`}</span>', '<span>{notice || "No notifications"}</span>',
    'const item = { label: "Settings" };', 't("missing.message")',
    '<span>{ready && "Ready"}</span>', '<span>{"Ready" as string}</span>',
  ]) assert.ok(sourceProblems(source).length, source);
  assert.deepEqual(sourceProblems('<input value="debug" className="text-field" placeholder={t("language.search")}/>'), []);
  assert.deepEqual(sourceProblems('const item = { label: "Settings" };', 'frontend/src/example.ts').length, 1);
});
