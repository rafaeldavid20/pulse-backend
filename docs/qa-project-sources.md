# QA: repositorios del proyecto

TES-318 separa autorización (`Project.repoFullNames`) de autenticación GitHub.
El preflight consulta la configuración actual del proyecto y las instalaciones
GitHub del mismo workspace. Todos los repos declarados deben estar disponibles;
no se elimina silenciosamente un repo privado o revocado del conjunto.

`pulseQaSource` autentica la key QA de Actions o la key efímera del job local
mediante `X-Pulse-QA-Credential`, separado de `Authorization` para evitar que
Cloud Run interprete la key de Pulse como credencial IAM de invocación.
Exige una revisión asignada a esa identidad y valida workspace/proyecto/job.
Para cada repo mintea una identidad de instalación nueva, limitada a ese repo,
con `contents:read` y `pull_requests:read`. Sólo el servidor la usa; la revoca
al terminar y nunca la almacena ni la devuelve al agente.

El preflight prueba metadatos, origen/head del PR, árbol y descarga del archivo.
Los repos con PR usan su SHA exacto; los repos de contexto usan el head de su
rama por defecto. La descarga posterior vuelve a validar autorización y head.
`qa_source_preflights` registra únicamente repos, SHAs, proyecto y fecha, y
permite iniciar QA sólo tras descargar todos los snapshots. El veredicto se
rechaza si cambió el proyecto, el PR o su head. Un fallo previo se comenta como
infraestructura por repo, sin emitir resultados funcionales ni tareas manuales
por criterio.

Los snapshots no contienen `.git`, son de sólo lectura y están acompañados por
`qa-sources.json`. Los archivos completos resuelven el fallback de diffs grandes.
El extractor rechaza traversal, enlaces y archivos especiales; limita cada ZIP
a 30 MiB comprimidos y 256 MiB expandidos. Repos más grandes o con enlaces se
bloquean con diagnóstico de infraestructura; no se revisa una copia incompleta.
Los submódulos no se descargan automáticamente: habilitar sus repos explícitamente
en el proyecto si su código debe formar parte del contexto.

Actions v7 verifica acceso antes de ejecutar `verify`. Ese job hace checkout del
SHA validado del anfitrión con `persist-credentials:false` y ejecuta los tests
sin secrets. El job de revisión descarga directamente todos los snapshots:
no se sube código privado a artefactos de un anfitrión público. La revisión
Claude lee archivos y emite el veredicto; no ejecuta scripts del PR.

Runner usa el mismo extractor con Python 3 (requisito adicional para QA).
Codex y Claude conservan sesiones locales independientes; no se usa la cuenta
Git/gh global para obtener snapshots. Ambos arrancan fuera de los repos, en un
directorio temporal confiable, para evitar cargar hooks/configuración del PR.
No se ejecutan builds/tests locales de QA con sesiones del proveedor presentes.

## Selección de QA

Un agente QA vinculado a Runner es de alcance proyecto: no necesita `reviewRepo`
ni conexiones GitHub Actions por repositorio. El dispatch prioriza QA Runner
autónomo y le firma en el job todos los repos habilitados del proyecto; el
preflight descarga los SHAs exactos de los PRs y los heads de contexto. Si hay
un QA Runner configurado pero no disponible, Pulse muestra el error y no cambia
silenciosamente a otro proveedor. Los agentes sin Runner mantienen el flujo
legacy de GitHub Actions limitado al `reviewRepo` configurado.

El modo `shadow` registra el veredicto, findings y comentarios, pero no cambia
el estado/asignación del issue ni dispara retrabajo. Puede usarse para observar
QA Codex durante el rollout sin convertir sus resultados en una barrera de
merge.

## Activación

Desplegar `pulseQaSource` y las funciones de revisión junto con esta versión del
backend. Publicar/actualizar el Runner local y reconectar los repos QA para
regenerar el workflow v7. Este cambio incluye los workflows generados de
pulse-backend y pulse-app; otros repos conectados deben actualizarse desde Pulse.
Codex en GitHub Actions sigue fuera del soporte existente: Codex QA utiliza
Runner local. No se agregan tokens personales ni autorización duplicada por agente.

La validación automatizada usa fixtures de tres repos, uno privado, acceso
faltante/revocado, cambios de repos, ambos proveedores e identidades, y ZIPs
inseguros. La prueba real con los tres repos privados se ejecuta tras desplegar
y actualizar (TES-217); los tests de fixtures no prueban los permisos de producción.
