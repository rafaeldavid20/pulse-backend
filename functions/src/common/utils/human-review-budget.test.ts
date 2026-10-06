import test from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE_WRITABLE_FIELDS, pickWritableFields } from './issue-fields';
test('manual budget renewal metadata cannot be set through writable issue fields',()=>{
 const fields: readonly string[] = ISSUE_WRITABLE_FIELDS;
 assert(!fields.includes('runBudgetResetAt'));
 assert(!fields.includes('runBudgetResetBy'));
 assert.deepEqual(pickWritableFields({runBudgetResetAt:new Date().toISOString(),runBudgetResetBy:'agent'},ISSUE_WRITABLE_FIELDS),{});
});
