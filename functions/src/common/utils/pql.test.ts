import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../pql/evaluator';
import { fixtureCases, fixtureContext, fixtureIssues } from '../pql/fixtures';

for (const fixture of fixtureCases) test(`portable PQL: ${fixture.query || '(empty)'}`, () => {
  const result = execute(fixture.query, fixtureIssues, fixtureContext);
  if ('ids' in fixture) {
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.issues.map(i => i.id), [...fixture.ids]);
  } else {
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual({ code: result.diagnostic.code, start: result.diagnostic.start, end: result.diagnostic.end }, { code: fixture.code, start: fixture.start, end: fixture.end });
  }
});
