import { getFirestore } from 'firebase-admin/firestore';

/**
 * Si el workspace tiene al menos un proyecto `kind: 'salesforce'` (TES-270).
 * Es lo que decide si se muestra la superficie de Salesforce: la pestaña de
 * Settings en el frontend (`hasSalesforceProject`) y las tools `pulse_sf_*`
 * del MCP.
 *
 * **Esto no es un control de seguridad.** Es para no ofrecer una superficie
 * que no aplica. La autorización real sigue siendo la de siempre:
 * `assertWorkspaceMember` en las acciones `environments.*`/`salesforce.*` y
 * el `workspaceId` del principal en el MCP, que es lo que impide leer la org
 * de otro workspace.
 *
 * Los entornos son del workspace, no del proyecto: dos proyectos Salesforce en
 * un mismo workspace comparten el espacio de claves (no puede haber dos `dev`),
 * porque la clave va en el nombre del secret del repo (`PULSE_SF_AUTH_<KEY>`).
 * Decisión de TES-270: un cliente distinto va en un workspace distinto.
 */
export async function workspaceHasSalesforceProject(workspaceId: string): Promise<boolean> {
  const snap = await getFirestore()
    .collection('projects')
    .where('workspaceId', '==', workspaceId)
    .where('kind', '==', 'salesforce')
    .limit(1)
    .get();
  return !snap.empty;
}

export const NO_SALESFORCE_PROJECT_MESSAGE =
  'Este workspace no tiene proyectos Salesforce. Marcá un proyecto con tipo "Salesforce" en Pulse (editar proyecto → Tipo de proyecto) y conectá la org desde Configuración → Salesforce.';
