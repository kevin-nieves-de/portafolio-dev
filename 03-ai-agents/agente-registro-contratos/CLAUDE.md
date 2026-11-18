# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

Reto técnico 02 de Periferia (Perxia 2.0): agente conversacional que actúa como **punto único
de recepción de contratos**. Lee un buzón simulado, extrae los datos de cada contrato, clasifica
(nuevo / actualización / duplicado / rechazado), archiva en un SharePoint simulado, alimenta el
maestro CSV y genera alertas de vencimiento y pólizas.

**El PRD no se versiona**: es un documento del proceso de selección y este repo es público. La
copia local vive en `PRD-02-agente-registro-contratos.md` junto a este archivo (ignorada por
`.gitignore`); si no está, pídesela al usuario. Nunca la agregues al repo ni cites su texto largo
en README, SOLUCION.md ni commits.

Este proyecto vive en el portafolio público del usuario (`portafolio-dev`), carpeta
`03-ai-agents/agente-registro-contratos/`; la raíz del repo Git está dos niveles arriba. Es
**independiente** del reto 01, un proyecto local fuera de este repo: la plataforma (adaptador LLM,
ciclo del agente, servidor, front) se copió de allá, no se importa ni se enlaza. Corre en puertos
distintos (backend :3002, front :5174) para que los dos puedan levantarse a la vez.

Código, identificadores, comentarios y docs **en español** (`leerMaestro`, `requiere_revision`).

## Estado

- Hecho: plataforma (paso 1), helpers de `src/tools/lib/` (paso 2), las 5 herramientas P0 y
  `demo.ts` (paso 3), `agent/prompt.md` y `src/knowledge/registro-contratos.md` (paso 4), front y
  endurecimiento del servidor (paso 5), `modulo/` (paso 8). La demo reproduce la tabla §7.4 del
  PRD para los 6 mensajes.
- Pendiente: `README.md`, `SOLUCION.md` (11 secciones, incluida la regla de gobierno §7.5),
  despliegue. `contratos_leer_pdf` (P1) no se implementa a propósito.

## Comandos

```bash
npm install && npm install --prefix web
npm run typecheck        # tsc --noEmit sobre src/, demo.ts, scripts/ y modulo/ (no incluye web/)
npm run demo             # demo.ts: las 5 herramientas sobre el buzón, sin LLM; borra out/ al inicio
npm run dev              # backend :3002 + front :5174
npm run sync:modulo      # regenera modulo/agent.md y SKILL.md desde prompt.md y knowledge/
npm run sync:modulo -- --check   # falla si modulo/ quedó desactualizado
```

`modulo/agent.md` y `modulo/skill/registro-contratos/SKILL.md` **se generan**: tras editar
`agent/prompt.md` o el conocimiento, corre `sync:modulo` en el mismo commit. `modulo/tools/contratos.ts`
es un reexport fijo de `src/tools/contratos.ts` (no un symlink ni una copia).

No hay framework de test: la verificación es `typecheck` + `demo`. `demo.ts` invoca las
herramientas por el mismo registro y la misma validación zod que `loop.ts`, e imprime `ok`/`x`;
un `x` es una regresión. Incluye los casos de error de HU-6 y la prueba de CA2 (sección 6).

## Git y seguridad (criterio eliminatorio del reto)

Cada paso terminado se reporta con un commit, con prefijo convencional como el resto del
portafolio (`feat:`, `fix:`, `docs:`, `chore:`) y mensaje en español. Nada de commits que toquen
otras carpetas del portafolio salvo `03-ai-agents/README.md`. Una falla de seguridad descalifica,
así que antes de cada commit:

- `git add -A --dry-run` y revisar que no entren `.env*` (salvo `.env.example`, que va con las
  claves **vacías**), `out/`, `node_modules/` ni llaves. El `.gitignore` ya los cubre.
- Buscar secretos en lo que se va a commitear (patrones `sk-ant-`, `AIza`, `api_key=…`).
- `npm audit` en la raíz y en `web/` debe dar 0 vulnerabilidades. Por eso el proyecto usa
  **zod 4** (zod 3 tiene GHSA-mrhx-c7xc-m3w5) y los adaptadores convierten esquemas con el nativo
  `z.toJSONSchema`, no con `zod-to-json-schema`. `exceljs`/`pdf-lib` del reto 01 se quitaron: aquí
  no se usan y arrastraban un `uuid` vulnerable.
- Las herramientas no ejecutan shell (PRD §8) y validan toda ruta que venga del modelo
  (`mensajeDir`, `rutaAdjunto` rechazan `..` y `/`).

## Arquitectura

Misma separación que evalúa el PRD §6.5: **comportamiento** en `agent/prompt.md`, **conocimiento**
en `src/knowledge/registro-contratos.md` (ambos se concatenan y cachean en `src/server.ts`;
reiniciar al editarlos), **ejecución** en `src/tools/`.

- `src/agent/tool-registry.ts` expone **cada export** de `src/tools/contratos.ts` como
  `contratos_<export>`. Los helpers van en `src/tools/lib/`, nunca como export de `contratos.ts`.
- Herramientas: `{ description, args (zod con .describe()), execute }`, `execute` devuelve string
  JSON `{ ok, data | error }` y nunca lanza (HU-6: un mensaje malo no aborta el lote).
- **Log único** `out/log.jsonl` (RN7 + CA4) vía `src/tools/lib/log.ts`: lo escriben las propias
  herramientas (así `demo.ts` también deja rastro); el ciclo del agente (`loop.ts`) solo registra
  las llamadas que rechaza antes de ejecutar (herramienta desconocida, args inválidos). Distinto
  del reto 01, que tenía dos logs.
- `src/tools/lib/esquemas.ts`: `contratoSchema` (sección 7.2 con `{ valor, confianza }` por campo)
  es a la vez la salida de `extraer` y la entrada de `validar`/`registrar`. `UMBRAL_CONFIANZA = 0.8`.
- Estado en disco: `out/sharepoint/maestro-contratos.csv` (copia del fixture, RN6, vía
  `inicializarMaestro`), `out/sharepoint/historial.jsonl`, `out/sharepoint/Contratos/<año>/<slug>/`,
  `out/procesados.json`, `out/alertas.md`. `fixtures/` es de solo lectura.
- Servidor (`src/server.ts`): el timeout (`AGENT_LLM_TIMEOUT_MS`, 120 s) es **por llamada al
  modelo** y vive en `loop.ts`; procesar el buzón encadena ~20 llamadas en un turno (~400k tokens),
  por eso el tope por sesión es 1M y hay un tope global (`AGENT_MAX_TOKENS_TOTAL`). Una sesión
  atiende un turno a la vez (`ocupada`). Sin CORS (mismo origen), cabeceras de seguridad con CSP
  estricta (`style-src 'self'`: nada de estilos inline en el front) y `ACCESS_KEY` comparada en
  tiempo constante.
- Adaptador Anthropic: API beta solo por `fallbacks: "default"` (reintento en otro modelo si el
  clasificador declina), `cache_control` automático y modelo por defecto `claude-opus-5-5`. Nunca
  reenvía bloques `thinking` (los descarta todos de forma consistente, así no choca con la
  verificación de historial editado).
- Front: `web/src/Markdown.tsx` renderiza el Markdown del agente como elementos React (nunca
  `dangerouslySetInnerHTML`): el texto puede citar correos de terceros.

## Decisiones de diseño de las herramientas (no obvias desde un solo archivo)

- **Las herramientas no confían en el modelo.** `validar` y `registrar` llaman a `evaluarContrato`
  (`lib/validacion.ts`), que relee el buzón y **reextrae** el documento: todo valor del `contrato`
  recibido que difiera de la extracción entra a `requiere_revision` (CA2). `registrar` revalida
  desde cero, no usa un `validar` previo.
- Quién cierra cada mensaje en `procesados.json`: `leer_buzon` los que no traen contrato (HU-1),
  `validar` los `duplicado`/`rechazado` (terminales, nada que escribir), `registrar` los demás.
  `registrar` sobre un mensaje ya procesado falla (idempotencia).
- RN1 compara solo `valor`, `fecha_inicio`, `fecha_fin`. En una actualización no se sobrescriben
  `cliente` ni `objeto` (el maestro guarda la redacción canónica); `nit_cliente`/`pais` distintos
  son conflicto. Un otrosí que extiende `fecha_fin` pasa la póliza `vigente` a `pendiente`.
- `fecha_registro` = fecha del correo, y el historial guarda `fecha_recepcion`: así `alertas` no
  depende del reloj y la demo es determinista salvo `ts`.
- Escala de confianza documentada en `lib/extraccion.ts`. msg-006 deja en revisión `valor`,
  `fecha_inicio` y `fecha_fin` (el PRD solo nombra valor y fecha_fin; `fecha_inicio` también es
  supuesta porque la firma no trae día). La propuesta `2026-09-01..2027-08-31` sale de tomar el
  envío del correo como cota de la firma y contar desde el día siguiente.
- `csv.ts` neutraliza inyección de fórmulas (celdas que empiezan con `= + - @`).

## Trampas de los fixtures (`fixtures/reto-02/`)

- El NIT de Periferia (`NIT_PERIFERIA`) aparece en todo contrato: el cliente es EL CONTRATANTE.
- Montos: buscar solo en la cláusula VALOR. En msg-006 el único monto con código (COP 100.000.000)
  es el umbral de la póliza, no el valor; el contrato es por demanda.
- `buscarPlazoEnMeses` aplicado al contrato entero captura "cuatro (4) meses más" de la póliza de
  msg-001: aplicarlo solo a la cláusula PLAZO.
- msg-001 y msg-002 comparten NIT/RUC con filas existentes pero con objeto distinto (similitud
  0.48 y 0.35): deben salir `nuevo`. msg-003 (otrosí) solo trae `fecha_fin` y `valor`; el resto
  se hereda de la fila. msg-006 no tiene día de firma (`buscarMesSinDia`) y el remitente no está
  en `comerciales.json` (se reporta, no bloquea).
- Convención de plazos del maestro: `finDePlazo(inicio, n)` = aniversario − 1 día.
