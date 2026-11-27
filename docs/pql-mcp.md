# `pulse_search` (PQL v1)

Con scope `issues:read`, `pulse_search` recibe `{ query, limit?, teamKey? }`.
`query` es obligatorio y puede ser vacío. `limit` por defecto es 25 y admite
1–100; `teamKey` limita el universo y aporta el contexto de ciclo. La
identidad (`me()`) y el workspace provienen de la credencial autenticada, no
de argumentos. Las credenciales de Runner atadas a un job conservan su límite
existente y no pueden usar esta búsqueda para recorrer el workspace.

```json
{"query":"status = in_review AND updated < -2d AND review.reviewer IS EMPTY ORDER BY updated ASC","limit":25,"teamKey":"TES"}
```

El resultado informa `queryVersion`, `evaluatedAt`, `issues`, `total`,
`returned`, `hasMore` y `scope`. El total se calcula antes de aplicar el
límite; `hasMore` indica que hay más coincidencias que filas devueltas. No hay
cursor en v1: refiná la consulta o aumentá `limit`. Fechas y funciones de
calendario usan UTC; `updated < -2d` es la última modificación, no el tiempo
transcurrido en el estado actual. `review.state = approved` consulta el estado
de QA; `review.verdict` es texto libre.

El servidor lee páginas ordenadas y rechaza más de 5000 candidatos con
`QUERY_SCOPE_TOO_LARGE`, sin entregar un total parcial. Las referencias a
épicas y padres por ID o identificador se buscan por lotes en el workspace;
para nombres legibles se necesita recorrer el catálogo y también se rechaza
si supera 5000, indicando que se utilicen IDs. Una lectura paginada no es un
snapshot transaccional: escrituras concurrentes pueden cambiar el conjunto
durante la lectura. Para volúmenes mayores hace falta la paginación de J1.
Errores de sintaxis, semántica o ámbito se devuelven con `isError`; los del
motor incluyen código y posiciones UTF-16. No se ejecuta una consulta inválida
como si estuviera vacía.

La fuente y el corpus viven en `pulse-app/src/lib/pql`. Desde ese checkout,
`PQL_BACKEND_ROOT=/ruta/al/worktree-backend npm run sync:pql` actualiza copia
y manifiestos. `npm run check:pql` exige un checkout backend y compara todos
los archivos y manifiestos; los workflows descargan la revisión del otro repo
y hacen fallar la verificación si difieren. El workflow backend ejecuta además
el corpus usando el contexto y adaptador reales del frontend y compara IDs,
orden y diagnósticos con las respuestas MCP en el emulador. En Functions,
`npm run check:pql` valida también la copia para el deploy aislado.
El despliegue y el smoke en producción
deben registrarse por separado cuando estén disponibles; el emulador no es
evidencia de despliegue.
