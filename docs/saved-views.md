# Vistas guardadas

`saved_views` se lee únicamente con membresía vigente y cuando la vista es
compartida o pertenece al usuario. Las escrituras de cliente están cerradas;
`views.create`, `views.update` y `views.delete` aplican las reglas de owner y
de administración de vistas de sistema. Las consultas se validan y las
referencias literales se guardan como IDs; las funciones dinámicas y fechas
relativas permanecen en la expresión.

Al crear un equipo, un trigger crea idempotentemente las cuatro vistas globales
y una vista de ciclo de ese equipo. Para workspaces existentes, después de
desplegar funciones y reglas, compilar Functions y ejecutar explícitamente:

```sh
cd functions
npm run build
npm run backfill:views -- --project PROJECT_ID --apply
```

El proceso usa las credenciales de aplicación disponibles en el entorno,
recorre los equipos existentes y no reemplaza vistas ya creadas ni ediciones.
Registrar por separado proyecto, fecha, salida y credencial autorizada usada;
agregar este script no implica que el backfill se haya ejecutado. Las vistas
de "Bloqueados" reflejan el estado del agente, no todas las dependencias.
