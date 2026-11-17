# Conocimiento del proceso: registro de contratos vigentes

Este documento describe el proceso de negocio que el agente aplica. Las herramientas
(`src/tools/contratos.ts` y `src/tools/lib/`) ejecutan estas reglas de forma determinista; el
agente las usa para explicar los resultados a la analista. Un cambio en el proceso se refleja
aquí y, si cambia un cálculo, en la lógica de la herramienta; nunca en el servidor.

## 1. Contexto

El maestro de contratos vigentes de Periferia está congelado desde el **2026-05-30**. Antes solo
llegaban a administración los contratos que exigían póliza. El agente es el punto único de
recepción: todo contrato que llegue al buzón se registra, **con o sin póliza**.

Países: Colombia (CO), Ecuador (EC), Perú (PE), Panamá (PA) y Honduras (HN).

| País | Identificador del cliente | Moneda habitual |
|---|---|---|
| CO | NIT | COP |
| EC | RUC | USD |
| PE | RUC | PEN |
| PA | RUC | USD (o PAB si el contrato dice balboas) |
| HN | RTN | HNL |

El NIT de Periferia (900123456) nunca es el `nit_cliente`: identifica a la otra parte.

## 2. Clasificación de cada mensaje

| Clasificación | Cuándo | Qué se escribe |
|---|---|---|
| `nuevo` | El contrato no coincide con ninguna fila del maestro. | Fila nueva, documento archivado, historial. |
| `actualizacion` | Mismo `id_contrato` (o mismo `nit_cliente` y `objeto` con similitud ≥ 0.9) con algún dato distinto, o el documento es un otrosí. | Se modifica la fila existente y el cambio queda en el historial con el antes y el después. |
| `duplicado` | Mismo `id_contrato` con el mismo `valor`, `fecha_inicio` y `fecha_fin`. Un otrosí que no cambia nada también es duplicado. | Nada. Se reporta y el mensaje se cierra. |
| `rechazado` | Sin adjunto de contrato (cotización, pregunta), texto sin partes u objeto identificables, o un otrosí de un contrato que no está en el maestro. | Nada. Se reporta con su motivo y el mensaje se cierra. |

Una actualización nunca sobrescribe `cliente` ni `objeto`: el maestro guarda su redacción
canónica. Si el documento trae otro `nit_cliente` u otro `pais` para el mismo contrato, no es una
actualización sino un conflicto que entra a revisión.

## 3. Confianza y revisión humana

Cada campo extraído trae una `confianza` entre 0 y 1:

| Confianza | Significado |
|---|---|
| 0.95 | El texto lo dice literalmente en su cláusula y otra señal lo confirma (por ejemplo, el valor en cifras y en letras). |
| 0.85 – 0.9 | Literal en su cláusula, sin segunda señal. |
| 0.8 | Inferencia segura (moneda por el país, póliza exigida de forma condicional). |
| 0.5 – 0.6 | Supuesto: hubo que asumir algo (fecha de firma sin día, valor por demanda). |
| 0 | El dato no está en el texto; el valor es `null`. Nunca se inventa. |

**Umbral: 0.8.** Un campo por debajo del umbral, un conflicto con el maestro o un valor distinto
al que dice el documento entra a `requiere_revision`. Con campos en revisión, el registro solo
procede con `confirmado = true`, después de que la analista confirme o corrija esos valores. La
herramienta vuelve a leer el documento antes de escribir, así que un valor alterado sin
confirmación no llega al maestro.

## 4. Reglas de los datos

- **Valor por demanda**: si el contrato no fija un valor total (bolsa de horas, tarifa por
  servicio), se registra `valor = 0` con `valor_indeterminado = true`, y siempre pasa por revisión.
- **Plazo en meses**: `fecha_fin` se deriva sumando los meses a `fecha_inicio` y restando un
  día (12 meses desde 2026-09-01 terminan el 2027-08-31). Si el plazo corre "desde la firma",
  empieza el día siguiente a la firma. Si la firma no dice el día exacto, las fechas son un
  supuesto y van a revisión.
- **`id_contrato`**: el número tal como aparece en el documento. Si no tiene, se asigna
  `AUTO-<año>-<secuencia>`.
- **`fecha_registro`**: la fecha en que el correo llegó al buzón.
- **Comercial**: el remitente se busca en `comerciales.json`. Si no está, se registra como
  `no registrado: <email>` y se avisa a la analista; no bloquea el registro.

## 5. Pólizas

| `estado_poliza` | Cuándo |
|---|---|
| `pendiente` | Contrato nuevo que exige póliza, o un otrosí que amplía el plazo de un contrato con póliza vigente (la póliza debe ampliarse). |
| `vigente` | La analista confirmó la póliza (dato que viene del maestro). |
| `vencida` | Dato del maestro. |
| `no_aplica` | El contrato no exige póliza. |

`tipo_poliza` es una lista separada por `;` (cumplimiento, calidad, responsabilidad civil…),
vacía si no se exige.

## 6. Archivo y trazabilidad

- El maestro de trabajo es `out/sharepoint/maestro-contratos.csv`, una copia del fixture. El
  fixture nunca se modifica.
- El documento se archiva en `out/sharepoint/Contratos/<año de inicio>/<cliente>/<id_contrato>.<ext>`.
  Un otrosí se archiva junto al contrato como `<id_contrato>-otrosi-<n>`.
- Cada escritura deja una línea en `out/sharepoint/historial.jsonl` con el antes y el después
  de cada campo y qué campos confirmó la analista.
- Cada mensaje atendido queda en `out/procesados.json` y deja de aparecer en el buzón.
- Cada llamada a una herramienta queda en `out/log.jsonl`.

## 7. Alertas

`contratos_alertas` recibe la fecha de referencia (`hoy`) y escribe `out/alertas.md` con:

1. **Vencen en 60 días o menos**: contratos con `fecha_fin` entre hoy y hoy + 60 días.
2. **Pólizas no vigentes**: contratos que exigen póliza y cuyo estado no es `vigente`.
3. **Registrados desde el corte**: lo que el agente insertó o actualizó desde el 2026-05-30,
   es decir, el hueco que el maestro congelado no cubría.

El reporte también lista los contratos ya vencidos que siguen en el maestro, para que la
analista decida si se renuevan o se cierran.
