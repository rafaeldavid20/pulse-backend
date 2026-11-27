import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../pql/evaluator';
import { fixtureCases, fixtureContexts, fixtureIssues } from '../pql/fixtures';

for (const fixture of fixtureCases) test(`portable PQL: ${fixture.query || '(empty)'}`, () => {
  const result = execute(fixture.query, fixtureIssues, fixtureContexts['context' in fixture ? fixture.context : 'default']);
  if ('ids' in fixture) {
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.issues.map(i => i.id), [...fixture.ids]);
  } else {
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual({ code: result.diagnostic.code, start: result.diagnostic.start, end: result.diagnostic.end }, { code: fixture.code, start: fixture.diagnostic.start, end: fixture.diagnostic.end });
  }
});
