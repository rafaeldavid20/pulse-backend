import { getFirestore } from 'firebase-admin/firestore';
import { FALLBACK_API_VERSION, sfFetch } from './client';
import { ENV_KEY_PATTERN } from '../actions/environments/shared';

/**
 * Lectura de una org en vivo (O2/TES-252): SOQL, Tooling SOQL, describe y
 * límites. Lo usan las acciones `salesforce.*`, que a su vez usan las tools
 * `pulse_sf_*` del MCP.
 */

// --- Resolver el entorno ----------------------------------------------

export interface ResolvedEnvironment {
  id: string;
  key: string;
  displayName: string;
  isProduction: boolean;
  apiVersion: string;
  instanceUrl?: string;
  connectionState?: string;
}

/**
 * Resuelve `ref` (el id `env-xxxx` o la clave `dev`) a un entorno **de
 * `workspaceId`**. El `workspaceId` lo pone el llamador desde algo que el
 * modelo no controla (el principal del MCP, el workspace del miembro), nunca
 * del input: un id de entorno de otro workspace responde igual que uno que no
 * existe, para no confirmar que es real.
 */
export async function resolveEnvironment(workspaceId: string, ref: string): Promise<ResolvedEnvironment> {
  const db = getFirestore();
  const trimmed = (ref || '').trim();
  if (!trimmed) throw new Error('Falta el entorno: pasá su clave (p. ej. "dev") o su id.');

  let data: FirebaseFirestore.DocumentData | undefined;
  if (ENV_KEY_PATTERN.test(trimmed)) {
    const snap = await db
      .collection('environments')
      .where('workspaceId', '==', workspaceId)
      .where('key', '==', trimmed)
      .limit(1)
      .get();
    data = snap.empty ? undefined : snap.docs[0].data();
  } else {
    const snap = await db.collection('environments').doc(trimmed).get();
    if (snap.exists && snap.data()!.workspaceId === workspaceId) data = snap.data();
  }
  if (!data) throw new Error(`No existe el entorno '${trimmed}' en este workspace.`);

  if (data.connectionState === 'expired' || data.connectionState === 'revoked') {
    throw new Error(
      `La conexión con la org del entorno '${data.key}' caducó o fue revocada. Hay que volver a conectarla desde Configuración → Salesforce.`
    );
  }

  return {
    id: data.id,
    key: data.key,
    displayName: data.displayName,
    isProduction: !!data.isProduction,
    apiVersion: data.salesforce?.apiVersion || FALLBACK_API_VERSION,
    instanceUrl: data.salesforce?.instanceUrl,
    connectionState: data.connectionState,
  };
}

// --- SOQL ---------------------------------------------------------------

/** Tope de filas que se devuelven en una respuesta, haya o no `LIMIT`. */
export const MAX_ROWS = 200;

/**
 * Un objeto con más registros que esto es "grande": un SOQL sin `LIMIT` sobre
 * él se rechaza. No es por el costo de la respuesta (eso lo corta `MAX_ROWS`)
 * sino por la org: un full scan sobre millones de filas consume límites del
 * cliente y puede disparar timeouts de query.
 */
export const LARGE_OBJECT_ROWS = 2000;

interface SoqlShape {
  /** Objeto del `FROM` de nivel superior (no el de una subquery). */
  sobject: string;
  hasLimit: boolean;
  /** `SELECT COUNT() FROM X` sin `GROUP BY`: la cuenta viene en `totalSize`, sin filas. */
  isPlainCount: boolean;
  /**
   * Sólo agregados (`COUNT(Id)`, `SUM(Amount) total`…) y sin `GROUP BY`:
   * una sola fila, así que no necesita `LIMIT` aunque el objeto sea grande.
   */
  isSingleRowAggregate: boolean;
}

/**
 * Análisis mínimo del SOQL, a nivel superior: ignora lo que está entre
 * paréntesis (subqueries de relación, `IN (...)`) y dentro de strings, para
 * que un `LIMIT` de una subquery no cuente como el de la query principal.
 */
export function inspectSoql(soql: string): SoqlShape {
  // `top` es la query con los strings y el contenido de cada paréntesis
  // reemplazados por un espacio, salvo un paréntesis vacío, que queda `()`:
  // `SELECT COUNT() FROM X WHERE Name = 'LIMIT 5'` queda
  // `SELECT COUNT() FROM X WHERE Name =  `, y `COUNT(Id)` queda `COUNT ` —
  // distinguirlos importa porque `COUNT(Id)` devuelve filas y `COUNT()` no (TES-279).
  let depth = 0;
  let inString = false;
  let groupStart = -1;
  let top = '';
  for (let i = 0; i < soql.length; i++) {
    const ch = soql[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      if (depth === 0) top += ' ';
    } else if (ch === '(') {
      if (depth === 0) groupStart = i;
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && groupStart >= 0) {
        top += soql.slice(groupStart + 1, i).trim() === '' ? '()' : ' ';
        groupStart = -1;
      }
    } else if (depth === 0) {
      top += ch;
    }
  }

  const upper = top.toUpperCase().replace(/\s+/g, ' ').trim();
  const select = /^SELECT (.+?) FROM ([A-Z0-9_]+)\b/.exec(upper);
  if (!upper.startsWith('SELECT ')) throw new Error('Sólo se admiten consultas SELECT.');
  if (!select) throw new Error('No se encontró el FROM de la consulta.');

  // El nombre del objeto sale de la query original para conservar mayúsculas.
  const sobject = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(top)![1];
  return {
    sobject,
    hasLimit: /\bLIMIT \d+/.test(upper),
    isPlainCount: /^COUNT\s*\(\)$/.test(select[1].trim()) && !/\bGROUP BY\b/.test(upper),
    isSingleRowAggregate:
      !/\bGROUP BY\b/.test(upper) &&
      select[1]
        .split(',')
        .every((item) => /^(COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX)\s*(\(\))?(\s+[A-Z0-9_]+)?$/.test(item.trim())),
  };
}

/** Cantidad aproximada de registros, de `/limits/recordCount`. `null` si la org no la informa. */
async function approximateRecordCount(environmentId: string, apiVersion: string, sobject: string): Promise<number | null> {
  try {
    const res = await sfFetch<{ sObjects: { name: string; count: number }[] }>(
      environmentId,
      `/services/data/v${apiVersion}/limits/recordCount?sObjects=${encodeURIComponent(sobject)}`
    );
    const hit = res?.sObjects?.find((o) => o.name.toLowerCase() === sobject.toLowerCase());
    return hit ? hit.count : null;
  } catch {
    return null;
  }
}

/** Saca `attributes` (tipo + url de cada registro): ruido para el modelo, y la mitad del tamaño. */
function stripAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAttributes);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'attributes') continue;
      out[k] = stripAttributes(v);
    }
    return out;
  }
  return value;
}

export interface QueryResult {
  /** Sólo en `SELECT COUNT()`: la cuenta. Salesforce la devuelve en `totalSize`, sin filas. */
  count?: number;
  totalSize: number;
  returned: number;
  truncated: boolean;
  records: unknown[];
  note?: string;
}

/**
 * Corre un SOQL (Data API o Tooling API) y devuelve como mucho `MAX_ROWS`
 * filas. Sin `LIMIT` sobre un objeto de datos grande, se rechaza antes de
 * llegar a la org. Para Tooling no hay `recordCount`, así que sólo corre el
 * tope de filas.
 */
export async function runSoql(
  env: ResolvedEnvironment,
  soql: string,
  opts: { tooling: boolean }
): Promise<QueryResult> {
  const query = (soql || '').trim().replace(/;\s*$/, '');
  const shape = inspectSoql(query);

  if (!opts.tooling && !shape.hasLimit && !shape.isPlainCount && !shape.isSingleRowAggregate) {
    const count = await approximateRecordCount(env.id, env.apiVersion, shape.sobject);
    if (count !== null && count > LARGE_OBJECT_ROWS) {
      throw new Error(
        `${shape.sobject} tiene ~${count} registros: agregá LIMIT (como mucho se devuelven ${MAX_ROWS} filas) o filtrá con WHERE y LIMIT. Para contar, usá SELECT COUNT() FROM ${shape.sobject}.`
      );
    }
  }

  const base = opts.tooling ? 'tooling/query' : 'query';
  const res = await sfFetch<{ totalSize: number; done: boolean; records: unknown[] }>(
    env.id,
    `/services/data/v${env.apiVersion}/${base}?q=${encodeURIComponent(query)}`,
    // Pide lotes chicos: si no, Salesforce arma y manda hasta 2000 filas que
    // después se descartan acá.
    { headers: { 'Sforce-Query-Options': `batchSize=${MAX_ROWS}` } }
  );

  // `SELECT COUNT()` no trae filas: la respuesta es `totalSize`. Sin este caso
  // salía como "truncada, 0 de 13", que le dice al modelo lo contrario (TES-279).
  if (shape.isPlainCount) {
    const count = res?.totalSize ?? 0;
    return { count, totalSize: count, returned: 0, truncated: false, records: [] };
  }

  const all = res?.records ?? [];
  const records = all.slice(0, MAX_ROWS).map(stripAttributes);
  const totalSize = res?.totalSize ?? records.length;
  const truncated = totalSize > records.length;
  return {
    totalSize,
    returned: records.length,
    truncated,
    records,
    ...(truncated
      ? { note: `Hay ${totalSize} filas y se devolvieron ${records.length}. Filtrá con WHERE o acotá con LIMIT.` }
      : {}),
  };
}

// --- Describe -----------------------------------------------------------

/**
 * Caché de describe en memoria de la instancia, 1h. La metadata cambia poco y
 * un describe de `Account` son cientos de KB; se pierde en cada cold start y
 * eso está bien. La clave incluye el entorno: dos orgs tienen campos distintos.
 */
const DESCRIBE_TTL_MS = 60 * 60 * 1000;
const describeCache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = describeCache.get(key);
  if (hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.value as T;
  const value = await load();
  describeCache.set(key, { at: Date.now(), value });
  return value;
}

/** Lista de objetos de la org (describe global), recortada a lo que sirve para orientarse. */
export async function describeGlobal(env: ResolvedEnvironment, opts: { tooling: boolean }) {
  const base = opts.tooling ? 'tooling/sobjects' : 'sobjects';
  return cached(`${env.id}:${base}:*`, async () => {
    const res = await sfFetch<{ sobjects: any[] }>(env.id, `/services/data/v${env.apiVersion}/${base}`);
    return (res?.sobjects ?? [])
      .filter((o) => o.queryable)
      .map((o) => ({ name: o.name, label: o.label, custom: !!o.custom }));
  });
}

/**
 * Describe de un objeto, sin la parte que no ayuda a escribir código (urls,
 * layouts, flags de UI). Lo que queda es lo que hace falta para escribir SOQL,
 * Apex o un campo nuevo sin adivinar: tipos, referencias, picklists activas,
 * relaciones hijas y record types.
 */
export async function describeSObject(env: ResolvedEnvironment, sobject: string, opts: { tooling: boolean }) {
  if (!/^[A-Za-z0-9_]+$/.test(sobject)) throw new Error(`Nombre de objeto inválido: '${sobject}'.`);
  const base = opts.tooling ? 'tooling/sobjects' : 'sobjects';
  return cached(`${env.id}:${base}:${sobject.toLowerCase()}`, async () => {
    const d = await sfFetch<any>(env.id, `/services/data/v${env.apiVersion}/${base}/${sobject}/describe`);
    return {
      name: d.name,
      label: d.label,
      custom: !!d.custom,
      keyPrefix: d.keyPrefix,
      fields: (d.fields ?? []).map((f: any) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        ...(f.length ? { length: f.length } : {}),
        ...(f.precision ? { precision: f.precision, scale: f.scale } : {}),
        ...(f.referenceTo?.length ? { referenceTo: f.referenceTo, relationshipName: f.relationshipName } : {}),
        ...(f.picklistValues?.length
          ? { picklistValues: f.picklistValues.filter((p: any) => p.active).map((p: any) => p.value) }
          : {}),
        ...(f.custom ? { custom: true } : {}),
        ...(f.calculated ? { calculated: true } : {}),
        ...(f.externalId ? { externalId: true } : {}),
        ...(f.unique ? { unique: true } : {}),
        nillable: !!f.nillable,
        createable: !!f.createable,
        updateable: !!f.updateable,
      })),
      childRelationships: (d.childRelationships ?? [])
        .filter((r: any) => r.relationshipName)
        .map((r: any) => ({ childSObject: r.childSObject, field: r.field, relationshipName: r.relationshipName })),
      recordTypes: (d.recordTypeInfos ?? [])
        .filter((r: any) => !r.master)
        .map((r: any) => ({ name: r.name, developerName: r.developerName, active: !!r.active })),
    };
  });
}
