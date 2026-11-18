# SOLUCIÓN — Agente de registro de contratos vigentes

Reto técnico 02 · Periferia IT Group · equipo Perxia 2.0

## 1. Problema en una frase

Periferia no sabe qué contratos tiene vigentes ni qué pólizas están por vencer, porque el maestro
dejó de alimentarse el 2026-05-30 y solo llegaban a administración los contratos con póliza.
Les duele a **la analista administrativa**, dueña del maestro, que hoy no puede confiar en él, y a
**la gerencia**, que no puede responder qué vence este trimestre ni qué riesgo de pólizas corre.

## 2. Arquitectura

```
┌──────────────────────┐  POST /api/chat   ┌──────────────────────────────────────────────┐
│ Front (React + Vite) │ ────────────────▶ │ Backend (Express, src/server.ts)             │
│ - historial del chat │ ◀──────────────── │ - sesiones en memoria, topes de costo         │
│ - cada tool call     │  reply, toolCalls │ - ciclo del agente (src/agent/loop.ts)        │
│ - resalta preguntas  │  needsConfirmation│ - adaptador LLM propio (src/llm/)             │
└──────────────────────┘                   └───────┬───────────────────────┬──────────────┘
                                                    │ zod valida args       │ enviar(mensajes,
                                                    ▼                       ▼ herramientas)
                                     ┌─────────────────────────┐   ┌──────────────────────┐
                                     │ Herramientas            │   │ Anthropic (o Gemini) │
                                     │ src/tools/contratos.ts  │   └──────────────────────┘
                                     │ + src/tools/lib/        │
                                     └──────┬──────────┬───────┘
                               solo lectura │          │ escritura
                                            ▼          ▼
                              fixtures/reto-02/     out/sharepoint/maestro-contratos.csv
                              (buzón, maestro,      out/sharepoint/Contratos/<año>/<cliente>/
                               comerciales)         out/sharepoint/historial.jsonl
                                                    out/procesados.json · out/alertas.md
                                                    out/log.jsonl
```

| Capa | Dónde vive | Regla |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Flujo, prohibición de afirmar valores, cómo pedir confirmación. |
| Conocimiento | `src/knowledge/registro-contratos.md` | Reglas del proceso en prosa: clasificación, confianza, pólizas, archivo, alertas. |
| Ejecución | `src/tools/contratos.ts` + `src/tools/lib/` | Determinista y tipada con zod. Única fuente de los valores. |
| Proveedor | `src/llm/adapter.ts` + `anthropic.ts` / `gemini.ts` | Cambiar de proveedor es escribir otra implementación; el ciclo no cambia. |

El servidor concatena el prompt y el conocimiento en el system prompt. Cambiar una regla de
negocio toca el conocimiento o la lógica de una herramienta, nunca el servidor.

`src/agent/tool-registry.ts` recorre los exports de `src/tools/contratos.ts` y expone cada uno al
modelo como `contratos_<export>`. Por eso ese archivo solo exporta herramientas y los helpers
viven en `src/tools/lib/`.

## 3. Ciclo del agente

`ejecutarTurno` (`src/agent/loop.ts`) agrega el mensaje del usuario al historial y repite:

1. Envía historial, system prompt y herramientas al adaptador, con un timeout **por llamada**
   (120 s). Un turno de buzón encadena entre 16 y 20 llamadas, así que un timeout por turno
   completo no sirve.
2. Si el modelo no pidió herramientas, el turno termina con su texto.
3. Si pidió herramientas, valida los argumentos de cada una con su esquema zod **antes** de
   ejecutarla. Un argumento inválido vuelve al modelo como error sin ejecutar nada. Los
   resultados se agregan al historial y el ciclo sigue.

**Tope de iteraciones (CA1):** 25 por turno (`AGENT_MAX_ITERATIONS`). Al alcanzarlo, el agente
responde con lo que tiene y avisa que puede continuar.

**Costo:** hay un tope de tokens por sesión (1M) y otro global del servidor (10M), para que abrir
sesiones nuevas no esquive el primero. Una sesión atiende un turno a la vez.

**Errores (CA5):** un error de herramienta llega al modelo como `{ ok: false, error }` y el lote
sigue. Un error o timeout del proveedor se muestra en el chat junto con las herramientas que
alcanzaron a ejecutarse. La sesión nunca muere.

**Trazabilidad (CA4):** cada llamada queda en `toolCalls` (el chat la muestra con su resultado y
sus argumentos) y en `out/log.jsonl`. Ese log lo escriben las propias herramientas, así que
`demo.ts` también deja rastro. El ciclo solo registra las llamadas que rechaza antes de ejecutar.

**Confirmación humana (CA3), en tres capas:**

1. **Prompt:** ante un campo en revisión, el agente no llama `registrar`. Muestra cada campo con
   su motivo y termina el turno con la pregunta. Solo usa `confirmado: true` si el siguiente
   mensaje del usuario confirma esos campos de forma inequívoca.
2. **Front:** `needsConfirmation` es `true` cuando la respuesta termina en pregunta, y el chat
   resalta ese mensaje. Es una heurística de presentación, no una garantía.
3. **Herramienta (la garantía real):** `contratos_registrar` vuelve a leer el buzón, reextrae el
   documento y reclasifica desde cero. Se niega a escribir si hay campos en revisión y
   `confirmado` no es `true`. Además, cualquier valor que el modelo haya cambiado respecto al
   documento entra a revisión (CA2), así que el modelo no puede "corregir" un valor por su cuenta.

## 4. Elección del modelo

**Proveedor y modelo:** Anthropic, `claude-opus-5-5`, con pensamiento adaptativo en esfuerzo
`medium`, que es el predeterminado del modelo. Gemini (`gemini-2.5-flash`) queda como alternativa
lista, porque el adaptador es intercambiable.

**Por qué:**

- El trabajo del modelo es orquestar muchas llamadas seguidas sin saltarse pasos.
- Debe pasar un objeto `contrato` grande sin alterarlo y respetar la regla de no registrar sin
  confirmación, aunque el correo diga lo contrario.
- La fiabilidad en uso de herramientas y en seguir instrucciones pesa más que el costo por token,
  porque el volumen es bajo: decenas de contratos al mes.
- Si el clasificador de seguridad declina un turno, el adaptador pide al servidor un reintento
  automático en otro modelo (`fallbacks`), en lugar de dejar el chat sin respuesta.

**Costo estimado.** Medí los tamaños reales de lo que viaja en un turno de buzón completo:

| Componente | Tamaño medido | Aproximado en tokens |
|---|---|---|
| System prompt + conocimiento | 11 k caracteres | 3,5 k |
| Esquemas de las 5 herramientas | 13 k caracteres | 4 k |
| Resultados de herramientas (todo el buzón) | 12 k caracteres | 4 k |
| Argumentos que escribe el modelo (`contrato`) | 6,6 k caracteres | 2,2 k |

Cálculo de un turno:

- **Llamadas:** entre 16 y 20, y cada una reenvía el historial. Eso suma unos 200 k tokens de
  entrada, en su mayoría leídos de la caché del prompt (activada en el adaptador).
- **Precios de `claude-opus-5-5`:** USD 4 por millón de tokens de entrada, USD 20 por millón de
  salida y USD 0,20 por millón leído de caché; escribir en caché cuesta 1,25 veces la entrada.
- **Desglose:** unos 15 k tokens escritos en caché (≈ USD 0,08), unos 180 k leídos de caché
  (≈ USD 0,04) y unos 8 a 12 k de salida entre argumentos, razonamiento y resumen (≈ USD 0,16 a
  0,24).

En total, **entre USD 0,25 y 0,40 por buzón de 6 mensajes, unos USD 0,05 a 0,07 por mensaje
procesado**. Confirmar un contrato en revisión es un turno corto: unos centavos.

Es una estimación sin medir en producción: la parte más incierta son los tokens de razonamiento.
Se valida con el `usage` de cada respuesta.

**El link público usa Gemini (`gemini-2.5-flash`) en su plan gratuito**, para que la demo no tenga
costo. Ese plan limita las solicitudes por minuto y por día. Ante un 429, el adaptador espera el
`retryDelay` que indica Google y reintenta hasta 3 veces dentro del timeout por llamada. Si la cuota
diaria se agota, lo dice en el chat en lugar de fallar en silencio. El costo es cero, a cambio de
turnos más lentos y de un modelo menos estricto siguiendo instrucciones largas. Para producción
recomiendo Anthropic; cambiar de uno a otro es solo una variable de entorno.

## 5. Estrategia de extracción

**La extracción es 100 % determinista** (`src/tools/lib/extraccion.ts`). El modelo nunca es la
fuente de un valor: el contrato llega como texto (`contrato.txt`) y se recorre **por cláusula**.
`buscarClausula` ubica bloques como "SEGUNDA. VALOR." o "(PLAZO)" para que un monto o una fecha
se tomen de la cláusula que les corresponde y no del primer número del documento.

| Campo | Cómo se obtiene |
|---|---|
| Tipo de documento | Encabezado: "OTROSÍ…" → `otrosi`; "CONTRATO…" con partes ("entre…") → `contrato`; si no, `otro` (rechazo). |
| `id_contrato` | Número en el encabezado ("No. CT-2026-015"). Si no hay, al registrar se asigna `AUTO-<año>-<secuencia>`. |
| Partes | Patrón "RAZÓN SOCIAL, identificada con NIT/RUC/RTN …". Se descarta la parte cuyo NIT es el de Periferia; la otra es el cliente. El NIT se normaliza sin puntos ni dígito de verificación. |
| `pais` | Por el tipo y el formato del identificador (NIT → CO, RTN → HN, RUC según formato) y, si hace falta, por el texto. |
| `objeto` | Cláusula de objeto, normalizada y truncada a 200 caracteres. |
| `valor` y `moneda` | Montos con código de moneda en la cláusula de valor ("COP $265.000.000", "USD 120,000.00"), con la convención de separadores de cada moneda. Si la cifra coincide con el valor en letras sube a 0.95. Un código fuera de COP/USD/PEN/PAB/HNL es error. Un contrato por demanda queda en `valor 0` con `valor_indeterminado` y confianza 0.5. |
| Fechas | Fechas literales de la cláusula de plazo ("1 de septiembre de 2026", "treinta (30) días del mes de…"), o fecha de inicio más plazo en meses. Si el plazo corre "desde la firma" y la firma no tiene día, la fecha del correo acota la firma: es un supuesto y va a revisión. |
| Pólizas | Cláusula de garantías: se exige o no, y qué tipos (cumplimiento, calidad, responsabilidad civil…). Una póliza exigida "para cada orden que supere X" es condicional: confianza 0.8. |

**Escala de confianza.** Es explícita y la misma en todo el código, no un número arbitrario:

| Confianza | Significado |
|---|---|
| 0.95 | Literal en su cláusula y confirmado por una segunda señal. |
| 0.85 – 0.9 | Literal en su cláusula, sin segunda señal. |
| 0.8 | Inferencia segura por una regla de negocio. |
| 0.5 – 0.6 | Supuesto (firma sin día, valor por demanda): siempre va a revisión. |
| 0 | El dato no está: `null`, nunca inventado. |

El umbral es 0.8 (RN5). En `requiere_revision` entran:

- los campos por debajo del umbral,
- los valores que el modelo cambió respecto al documento,
- los conflictos de identidad con el maestro (otro NIT u otro país para el mismo contrato).

**Clasificación (`src/tools/lib/validacion.ts`):**

- **Búsqueda:** primero por `id_contrato`. Como respaldo, mismo `nit_cliente` con `objeto`
  similar en ≥ 0.9 (coeficiente de Dice sobre bigramas). Medido sobre los fixtures, las filas con
  el mismo NIT quedan entre 0.25 y 0.40, lejos del umbral: un contrato nuevo de un cliente
  existente no se confunde con uno anterior. Esto incluye el mismo contrato reenviado en msg-004,
  porque el maestro guarda una redacción más corta; ese caso se reconoce por id. El respaldo es
  conservador a propósito y la identificación descansa en el número del contrato.
- **Duplicado:** mismo id y mismos valor y fechas. Un otrosí que no cambia nada también es
  duplicado.
- **Actualización:** coincidencia con algún dato distinto. Se escriben solo los campos
  actualizables (valor, moneda, fechas, pólizas). `cliente` y `objeto` conservan la redacción
  canónica del maestro.

**Dónde entra el modelo y dónde no.** El modelo decide el orden de las llamadas, interpreta la
intención de la analista, explica resultados y redacta la pregunta de confirmación. No extrae, no
clasifica, no calcula fechas y no escribe nada que no haya validado una herramienta.

## 6. Regla de gobierno

**Propuesta: "Todo contrato pasa por el buzón".**

**1. Canal único.** Todo documento contractual se envía a `contratos@periferia-ficticia.com`.
- La administra la **analista administrativa**, dueña del maestro, y tiene un respaldo designado
  para ausencias.
- El agente opera sobre ese buzón. Nadie más recibe contratos por correo personal.
- La dueña del maestro responde ante la **gerencia administrativa y financiera**. Así se resuelve
  la pregunta de quién es el dueño cuando no hay área legal.

**2. Obligación del comercial.**
- **Qué envía:** el PDF firmado de **todo** contrato (con o sin póliza), cada otrosí o prórroga y
  cada acta de terminación o liquidación. No envía cotizaciones ni borradores.
- **Plazo:** 3 días hábiles desde la firma.
- **Formato:** un documento por correo, con asunto `[CONTRATO|OTROSI|TERMINACION] <número> - <cliente> - <NIT>`.
  Ejemplo: `[OTROSI] CT-2026-011 - Minera Los Andes - 20512345678`.
- Esta obligación se incluye en la inducción comercial y en el checklist de cierre de cada negocio.

**3. Acuse automático.** El mismo día hábil, el agente responde al remitente con:
- la clasificación (registrado, actualizado, duplicado o rechazado),
- el `id_contrato` y la ruta donde quedó archivado,
- los campos que la analista debe confirmar y, si fue rechazado, el motivo y qué reenviar.

**4. Excepciones y escalamiento.**

| Caso | Qué pasa |
|---|---|
| Contrato sin firma | No se registra. Acuse "pendiente de firma" y recordatorio a los 3 días hábiles. A los 5 días se escala al gerente comercial. |
| Contrato sin valor (por demanda) | Se registra con `valor 0` tras la confirmación de la analista. Las órdenes de servicio que superen el umbral de póliza se reportan como otrosí. |
| Datos en conflicto con el maestro | La analista decide. Si no puede resolverlo con el comercial en 5 días hábiles, escala a la gerencia administrativa. |
| Remitente desconocido | Se registra igual y se avisa para dar de alta al comercial. |

**5. Cierre del gap de junio a agosto de 2026: una campaña de dos semanas.**
- **Semana 1:** finanzas entrega la lista de clientes facturados entre el 2026-06-01 y el
  2026-08-31. Cada comercial reenvía al buzón los contratos y otrosíes firmados o modificados
  desde el 2026-05-30, con el prefijo `[GAP-2026]` en el asunto. El agente los procesa en lote.
- **Semana 2:** la analista cruza la facturación contra el maestro y persigue los faltantes por
  comercial.
- La campaña cierra cuando todo cliente facturado en ese periodo tiene su contrato en el maestro.

**6. Indicador.** Porcentaje de contratos facturados en el mes que existen en el maestro, con meta
≥ 98 %. Se reporta mensualmente a gerencia junto con dos métricas de apoyo:
- días medianos entre la firma y el registro (meta ≤ 3),
- porcentaje de pólizas exigidas en estado `vigente`.

## 7. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Extracción determinista; el modelo solo orquesta. | Que el modelo extraiga los campos del texto. | Un valor inventado o redondeado por el modelo corrompe el maestro sin dejar rastro. Con reglas por cláusula cada valor es reproducible, auditable y tiene una confianza explicable. El costo es menos flexibilidad ante redacciones nuevas, que se cubre con la revisión humana. |
| 2 | `validar` y `registrar` reextraen el documento y revalidan desde cero. | Confiar en el `contrato` y la clasificación que pasa el modelo. | Es lo que hace cumplir CA2 en el diseño y no solo en el prompt: un valor alterado entra a revisión. Cuesta leer el documento dos veces, que es despreciable. |
| 3 | Estado del lote en archivos (`procesados.json`, maestro, historial) con orden de escritura archivo → maestro → historial → procesados. | Pasar el estado entre herramientas por argumentos. | Si el proceso falla a mitad, nunca queda una fila apuntando a un archivo inexistente, y un mensaje no se registra dos veces. |
| 4 | CSV propio de unas 60 líneas, con neutralización de fórmulas. | Una librería CSV. | El maestro tiene un solo formato fijo; una dependencia menos que auditar. La neutralización evita que un `objeto` que empiece con `=` se ejecute al abrir el maestro en Excel. |
| 5 | Timeout por llamada al modelo. | Timeout por turno (venía de la plataforma reutilizada). | Un turno de buzón no cabe en 60 s y, al vencer, el ciclo seguía escribiendo archivos en segundo plano. |
| 6 | Sesiones aisladas en el despliegue (`out/sesiones/<id>/`). | Un solo `out/` compartido. | En un link público, quien procesa el buzón primero se lo "consume" a los demás, incluido el evaluador. Se implementó sin tocar las herramientas: cambia el `ctx.directory` de cada sesión. En local queda apagado para conservar las rutas del PRD. |
| 7 | Render de Markdown propio en el chat. | `react-markdown` o `innerHTML`. | El texto del agente puede citar correos de terceros. Construir elementos de React elimina el riesgo de XSS sin agregar dependencias. |
| 8 | `modulo/tools/contratos.ts` reexporta las herramientas. | Symlink o copia. | Es el mismo código, funciona en Windows y lo verifica el typecheck. `sync:modulo -- --check` detecta prompt o conocimiento desactualizados. |
| 9 | No implementar `contratos_leer_pdf` (P1). | Agregar un parser de PDF. | Los fixtures no traen PDF y un parser es superficie de ataque y dependencia extra. Un adjunto no legible se reporta y no se procesa. |

## 8. Supuestos

- **Fecha de registro:** `fecha_registro` es la fecha en que el correo llegó al buzón, no la del
  sistema. Así la demo es reproducible y la fecha es auditable contra el correo. El historial
  guarda además la marca de tiempo real.
- **Plazo en meses:** termina el día anterior al aniversario (12 meses desde 2026-09-01 terminan
  el 2027-08-31). Un plazo "contado desde la firma" empieza el día siguiente a la firma.
- **msg-006:**
  - El contrato dice "firmado en agosto de 2026" sin día, con 12 meses desde la firma, y el correo
    es del 2026-08-31. La firma fue a más tardar ese día, así que el inicio supuesto es el
    2026-09-01 y el fin el 2027-08-31, que es lo que espera el PRD.
  - **Desviación consciente:** además de `valor` y `fecha_fin`, también marco `fecha_inicio`
    para revisión, porque es exactamente el mismo supuesto. Registrarla sin confirmar
    contradiría RN5.
  - La confirmación de la analista resuelve los tres campos en un solo paso.
- **Otrosíes:**
  - Un otrosí sin cambios es duplicado.
  - Uno de un contrato que no está en el maestro se rechaza.
  - Si amplía `fecha_fin` y la póliza estaba `vigente`, pasa a `pendiente`, porque la póliza debe
    ampliarse.
  - Se archiva como `<id>-otrosi-<n>` junto al contrato.
- **Pólizas condicionales:** una póliza exigida solo para órdenes que superen un monto se registra
  como `requiere_poliza = true` en estado `pendiente`.
- **Remitente:** uno que no está en `comerciales.json` se registra como
  `comercial = "no registrado: <email>"` y se avisa. No bloquea, como pide HU-3.
- **Moneda en Panamá:** USD, salvo que el contrato diga balboas (PAB).
- **Formatos legibles:** solo `.txt`. Cualquier otro adjunto se reporta como no legible.
- **Alertas:** además de las tres secciones pedidas, el reporte lista como contexto los contratos
  ya vencidos que siguen en el maestro.

## 9. Cobertura

| Historia / criterio | Estado | Nota |
|---|---|---|
| HU-1 Leer el buzón | Hecho | Los mensajes sin contrato salen como `rechazado` con motivo. |
| HU-2 Extraer | Hecho | Determinista, con confianza por campo; ausente = `null` con confianza 0. |
| HU-3 Validar y clasificar | Hecho | RN1–RN4, revisión por confianza, conflictos y valores alterados; comercial resuelto o avisado. |
| HU-4 Registrar y archivar | Hecho | Maestro, archivo, historial y procesados; exige `confirmado` si hay revisión. |
| HU-5 Alertar | Hecho | `out/alertas.md` con fecha de referencia explícita. |
| HU-6 Errores | Hecho | 7 casos en la demo; ninguno detiene el lote. |
| CA1 – CA5 | Hecho | Tope de iteraciones, CA2 en el diseño, confirmación, log y errores en el chat. |
| RN1 – RN7 | Hecho | |
| `demo.ts` | Hecho | 29 `ok`, 0 `x`; segunda pasada con `confirmado: true` para msg-006. |
| `contratos_leer_pdf` (P1) | No hecho | Decisión 9. |
| Link público | Parcial | `render.yaml` listo; el despliegue requiere la cuenta de Render y la API key del autor. |
| Bonus `modulo/` | Hecho | Generado desde las mismas fuentes que usa la app. |

**Qué falta para producción:**

- Leer el buzón real (Microsoft Graph) y escribir en SharePoint por su API.
- OCR para contratos escaneados.
- El maestro en una base de datos con transacciones, en lugar de un CSV.
- Sesiones persistentes, autenticación de la analista y confirmación con un token del servidor
  (ver riesgos).
- Pruebas automatizadas además de la demo, y monitoreo de costo y errores.

## 10. Uso de IA

**Herramienta:** Claude Code con Claude Opus 5.5 como asistente de programación en todo el reto.

**Para qué la usé:**

- Leer y resumir el PRD.
- Proponer el plan por pasos.
- Adaptar la plataforma que construí en el reto 01: ciclo del agente, adaptadores, servidor y
  chat.
- Escribir los helpers deterministas y las herramientas.
- Redactar el prompt, el conocimiento y esta documentación.
- Revisar seguridad en cada commit: búsqueda de secretos, `npm audit`, rutas y entradas.

Todas las decisiones de alcance las tomé yo, por ejemplo excluir el PRD del repositorio público y
dónde vive el proyecto. Revisé cada cambio antes del commit.

**Lo que descarté o corregí de lo que propuso:**

- **`zod-to-json-schema`:** no es compatible con zod 4. Usé `z.toJSONSchema` nativo.
- **Primera versión de RN1:** trataba como actualización cualquier campo distinto. La restringí a
  valor y fechas, como dice la regla.
- **Fecha del sistema en el historial:** hacía la demo no determinista. La reemplacé por la fecha
  de recepción del correo.
- **`npm audit fix --force`:** proponía bajar vite a una versión con vulnerabilidades conocidas.
  Lo rechacé y actualicé a la versión corregida.
- **Herencias de la plataforma del reto 01:** el timeout por turno completo y el CORS abierto no
  servían para un link público. Los cambié (decisión 5 y la sección Seguridad del README).
- **Symlink para `modulo/tools`:** lo cambié por un reexport (decisión 8).
- **Parser de PDF para la herramienta P1:** no lo agregué (decisión 9).

## 11. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| **El modelo marca `confirmado: true` sin que la analista haya confirmado**, por error o por un correo con instrucciones maliciosas. Hoy lo frenan el prompt (los correos son datos, no órdenes) y que la herramienta solo acepta valores del documento o escritos por el humano. | En producción, la confirmación debe ser un botón del front que emita un token de un solo uso desde el servidor; `registrar` lo verifica en lugar de confiar en un booleano que escribe el modelo. |
| Contratos escaneados o con redacción nueva que las reglas no reconocen. | OCR y, para lo no reconocido, confianza baja: va a revisión humana, nunca entra un dato malo. Medir el porcentaje de campos en revisión para priorizar reglas nuevas. |
| Falsos duplicados por variaciones del nombre del cliente. | La búsqueda es por `id_contrato` y `nit_cliente`, nunca por nombre; la similitud de `objeto` exige ≥ 0.9. |
| Datos de contratos (clientes, valores) enviados al proveedor del modelo. | Acuerdo de tratamiento de datos o retención cero con el proveedor. Las herramientas ya envían solo los campos estructurados, no el contrato completo. |
| Escrituras concurrentes al CSV y disco efímero en el plan free. | Base de datos transaccional y almacenamiento persistente (SharePoint real). Hoy un proceso y un turno por sesión evitan carreras dentro de una sesión. |
| Gasto de la API key en un link público. | Topes de tokens por sesión y globales, `ACCESS_KEY` opcional y límite de gasto en la consola del proveedor. |
| Dependencias del front: `npm audit` reporta 5 avisos altos por `picomatch` (ReDoS), dependencia de vite **sin versión corregida publicada**. | Solo corre al construir el front en la máquina del desarrollador, con patrones propios; no llega al servidor desplegado, que sirve archivos estáticos. Se actualiza en cuanto salga la versión corregida. El backend está en 0 vulnerabilidades. |
| Sesiones en memoria: se pierden al reiniciar. | Persistirlas (Redis o base de datos) junto con la autenticación. |
| Dependencia de una persona. | La regla de gobierno define dueño, respaldo, plazos e indicador; el conocimiento del proceso está escrito y versionado, no en la cabeza de alguien. |
