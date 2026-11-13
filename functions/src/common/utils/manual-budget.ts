import { IssueRunBudgetReason } from './issue-run-budget';
import { WorkspaceBudgetReason } from './dispatch-counter';

export type ManualBudgetException = IssueRunBudgetReason | Exclude<WorkspaceBudgetReason, 'paused'>;
const allowed: ManualBudgetException[] = ['issue-run-limit', 'issue-cost-cap', 'daily-dispatch-limit', 'daily-cost-cap'];

export function manualBudgetExceptions(value: unknown): ManualBudgetException[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(v => !allowed.includes(v))) throw new Error('Autorización de límite inválida.');
  return [...new Set(value)];
}

export function budgetBlocked(reason: string, amount?: number): Error {
  return new Error(`PULSE_BUDGET:${reason}:${amount ?? ''}`);
}
