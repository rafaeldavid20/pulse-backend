import { nanoid } from 'nanoid';
import { FindingSeverity, ReviewCriterionResult, ReviewFinding } from '../domain.generated';

const SEVERITIES: FindingSeverity[] = ['blocker', 'major', 'minor', 'nit'];
const CRITERION_RESULTS: ReviewCriterionResult['result'][] = ['pass', 'fail', 'unverifiable'];

/**
 * Normaliza los findings que manda un QA en `pulse_submit_review`: valida la
 * severidad, y asigna un `id` estable (no un índice) porque el re-trabajo de
 * D9 y "Descartar finding" de D7 lo referencian para actualizar `status` sin
 * depender de la posición en el array. Todo finding nuevo entra `open`.
 *
 * `criterionId` y `dodId` (D14) son mutuamente excluyentes en la práctica —
 * un finding es sobre la rúbrica del issue o sobre la Definition of Done del
 * proyecto— pero acá no se fuerza esa exclusión: ambos son solo referencias
 * de texto libre, y no vale la pena rechazar un finding válido por un caller
 * que mandó los dos.
 */
export function normalizeFindings(input: unknown): ReviewFinding[] {
  if (!Array.isArray(input)) return [];

  return input
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof f.message === 'string' && f.message.trim().length > 0)
    .map((f) => {
      const severity = f.severity as FindingSeverity;
      if (!SEVERITIES.includes(severity)) {
        throw new Error(`Severidad de finding inválida: '${String(f.severity)}'. Debe ser una de: ${SEVERITIES.join(', ')}.`);
      }
      const finding: ReviewFinding = {
        id: `fnd-${nanoid(8)}`,
        severity,
        status: 'open',
        message: (f.message as string).trim(),
      };
      if (typeof f.criterionId === 'string' && f.criterionId) finding.criterionId = f.criterionId;
      if (typeof f.dodId === 'string' && f.dodId) finding.dodId = f.dodId;
      if (typeof f.repoFullName === 'string' && f.repoFullName) finding.repoFullName = f.repoFullName;
      if (typeof f.file === 'string' && f.file) finding.file = f.file;
      if (typeof f.line === 'number') finding.line = f.line;
      return finding;
    });
}

/** Normaliza `criteriaResults`: valida el `result` y descarta entradas sin `criterionId`. */
export function normalizeCriteriaResults(input: unknown): ReviewCriterionResult[] {
  if (!Array.isArray(input)) return [];

  return input
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof c.criterionId === 'string' && c.criterionId)
    .map((c) => {
      const result = c.result as ReviewCriterionResult['result'];
      if (!CRITERION_RESULTS.includes(result)) {
        throw new Error(`Resultado de criterio inválido: '${String(c.result)}'. Debe ser uno de: ${CRITERION_RESULTS.join(', ')}.`);
      }
      const criterionResult: ReviewCriterionResult = { criterionId: c.criterionId as string, result };
      if (typeof c.evidence === 'string' && c.evidence) criterionResult.evidence = c.evidence;
      return criterionResult;
    });
}

/**
 * Findings `blocker` que siguen abiertos en la revisión vigente del issue.
 *
 * Es la tercera condición que frena el cierre automático, junto con los
 * criterios `not_met` sin dueño y los pendientes sin follow-up (D23/TES-271).
 *
 * Solo `blocker`. `major` avisa pero no frena a propósito: si también
 * trabara el merge, cada cierre se vuelve una negociación y la salida
 * natural pasa a ser descartar findings por trámite — que es peor que no
 * tenerlos, porque deja el registro diciendo que alguien los evaluó.
 *
 * `disputed` tampoco frena: el dev ya dejó por escrito por qué no está de
 * acuerdo y eso queda en el historial. Si el QA insiste, es una conversación
 * entre personas, no un candado.
 */
export function openBlockerFindings(issue: FirebaseFirestore.DocumentData): ReviewFinding[] {
  const findings: ReviewFinding[] = issue.review?.findings || [];
  return findings.filter((f) => f?.status === 'open' && f?.severity === 'blocker');
}
