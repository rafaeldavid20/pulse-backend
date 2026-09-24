import test from 'node:test';
import assert from 'node:assert/strict';
import { canAssignExecutionAgent, canManageAgent } from './agent-authorization';

test('un miembro no puede administrar el agente personal de otro miembro', () => {
  const agent = { ownerMemberId: 'owner-a', visibility: 'personal' };
  assert.equal(canManageAgent(agent, 'member-b', false), false);
  assert.equal(canManageAgent(agent, 'owner-a', false), true);
  assert.equal(canManageAgent(agent, 'admin-c', true), true);
});

test('un agente personal solo se asigna por su dueño a su propio issue', () => {
  const agent = { ownerMemberId: 'owner-a', visibility: 'personal' };
  assert.equal(canAssignExecutionAgent(agent, 'owner-a', 'owner-a', false), true);
  assert.equal(canAssignExecutionAgent(agent, 'owner-a', 'member-b', true), false);
  assert.equal(canAssignExecutionAgent(agent, 'member-b', 'member-b', true), false);
});

test('los agentes públicos requieren admin para asignación y administración', () => {
  const agent = { ownerMemberId: 'owner-a', visibility: 'public' };
  assert.equal(canManageAgent(agent, 'member-b', false), false);
  assert.equal(canAssignExecutionAgent(agent, 'member-b', 'member-b', false), false);
  assert.equal(canManageAgent(agent, 'admin-c', true), true);
  assert.equal(canAssignExecutionAgent(agent, 'admin-c', 'member-b', true), true);
});
