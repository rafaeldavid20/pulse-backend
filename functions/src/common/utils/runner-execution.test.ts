import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRunnerExecutionMetadata} from './runner-execution';

const metadata = {provider:'codex',cliVersion:'1.2.3',requestedModel:'gpt-6-sol',requestedModelSource:'local_profile',effectiveModel:null,effectiveModelSource:'unknown',reasoningLevel:null,reasoningLevelSource:'unknown',runConfigVersion:2,runConfigMode:'task',runConfigOrigin:'pulse'};

test('execution metadata keeps explicit requested model and honest unknowns',()=>{
  assert.deepEqual(parseRunnerExecutionMetadata(metadata),metadata);
  assert.equal(parseRunnerExecutionMetadata({...metadata,requestedModel:'Bearer secret'}),null);
  assert.equal(parseRunnerExecutionMetadata({...metadata,effectiveModel:'gpt-6-sol',effectiveModelSource:'unknown'}),null);
  assert.equal(parseRunnerExecutionMetadata({...metadata,effectiveModel:'gpt-6-sol',effectiveModelSource:'observed'}).effectiveModel,'gpt-6-sol');
  assert.equal(parseRunnerExecutionMetadata({...metadata,reasoningLevel:'high',reasoningLevelSource:'unknown'}),null);
  assert.equal(parseRunnerExecutionMetadata({...metadata,runConfigOrigin:'local'}),null);
});
