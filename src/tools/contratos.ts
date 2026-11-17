/**
 * Herramientas del agente. Cada `export const` se expone al modelo como `contratos_<export>`
 * (ver src/agent/tool-registry.ts), así que aquí NO se exporta nada más: la lógica vive en
 * src/tools/lib/ y estas funciones solo validan, delegan, registran en el log y serializan.
 *
 * Contrato (PRD §6.2): `execute` devuelve un string JSON `{ ok: true, data }` o
 * `{ ok: false, error }` y nunca lanza, para que un mensaje malo no detenga el lote (HU-6).
 */
import { z } from "zod"
import { generarAlertas } from "./lib/alertas.js"
import { leerCorreo, leerProcesados, listarIdsMensajes, marcarProcesado } from "./lib/buzon.js"
import { buscarAdjuntoDeContrato } from "./lib/documento.js"
import { contratoSchema, fechaIsoSchema, type Clasificacion } from "./lib/esquemas.js"
import { extraerContrato } from "./lib/extraccion.js"
import { registrarLog } from "./lib/log.js"
import { registrarContrato } from "./lib/registro.js"
import { evaluarContrato } from "./lib/validacion.js"
import type { ToolArgsShape, ToolContext, ToolDefinition } from "./types.js"

const mensajeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "solo letras, números, guion y guion bajo")
  .describe('Id del mensaje del buzón, por ejemplo "msg-001"')

export const leer_buzon = herramienta({
  description:
    "Lista los mensajes del buzón de contratos que aún no se han procesado, indicando si cada uno trae un contrato adjunto; los que no traen contrato quedan rechazados con su motivo.",
  args: {},
  execute: (_args, ctx) =>
    ejecutar(ctx, "contratos_leer_buzon", null, async () => {
      const procesados = new Set((await leerProcesados(ctx.directory)).map((p) => p.mensaje_id))
      const pendientes = (await listarIdsMensajes(ctx.directory)).filter((id) => !procesados.has(id))

      const mensajes = []
      for (const id of pendientes) {
        const correo = await leerCorreo(ctx.directory, id)
        const adjunto = await buscarAdjuntoDeContrato(ctx.directory, correo)
        let clasificacion: Clasificacion | null = null
        let motivo: string | null = null
        if (adjunto.estado === "ninguno") {
          // HU-1: sin contrato adjunto se clasifica rechazado aquí mismo y sale del buzón.
          clasificacion = "rechazado"
          motivo = adjunto.motivo
          await marcarProcesado(ctx.directory, { mensaje_id: id, clasificacion, id_contrato: null, motivo, ts: new Date().toISOString() })
        } else if (adjunto.estado === "no_legible") {
          motivo = adjunto.motivo
        }
        mensajes.push({
          id: correo.id,
          de: correo.de,
          asunto: correo.asunto,
          fecha: correo.fecha,
          adjuntos: correo.adjuntos,
          tiene_contrato: adjunto.estado === "encontrado",
          tipo_documento: adjunto.estado === "encontrado" ? adjunto.tipo : null,
          clasificacion,
          motivo,
        })
      }
      const conContrato = mensajes.filter((m) => m.tiene_contrato).length
      return {
        data: { mensajes, ya_procesados: procesados.size },
        resumen: `${mensajes.length} pendientes, ${conContrato} con contrato`,
      }
    }),
})

export const extraer = herramienta({
  description:
    "Extrae de forma determinista los datos del contrato adjunto a un mensaje (esquema 7.2) con la confianza de cada campo; los datos ausentes vuelven en null con confianza 0.",
  args: { mensaje_id: mensajeIdSchema },
  execute: ({ mensaje_id }, ctx) =>
    ejecutar(ctx, "contratos_extraer", mensaje_id, async () => {
      const correo = await leerCorreo(ctx.directory, mensaje_id)
      const adjunto = await buscarAdjuntoDeContrato(ctx.directory, correo)
      if (adjunto.estado !== "encontrado") throw new Error(`no hay contrato que extraer: ${adjunto.motivo}`)

      const contrato = extraerContrato(adjunto.texto, { fechaCorreo: correo.fecha })
      const bajas = Object.entries(contrato).filter(
        ([, v]) => typeof v === "object" && v !== null && "confianza" in v && v.confianza < 0.8 && v.valor !== null,
      ).length
      return {
        data: contrato,
        resumen: `${contrato.tipo_documento} ${contrato.id_contrato.valor ?? "sin número"}, ${bajas} campos con confianza baja`,
      }
    }),
})

export const validar = herramienta({
  description:
    "Clasifica un contrato extraído como nuevo, actualizacion, duplicado o rechazado contra el maestro y lista los campos que requieren revisión humana; los duplicados y rechazados quedan cerrados.",
  args: {
    mensaje_id: mensajeIdSchema,
    contrato: contratoSchema.describe("Contrato tal como lo devolvió contratos_extraer"),
  },
  execute: ({ mensaje_id, contrato }, ctx) =>
    ejecutar(ctx, "contratos_validar", mensaje_id, async () => {
      const { resultado } = await evaluarContrato(ctx.directory, mensaje_id, contrato)
      // Duplicado y rechazado son terminales: no hay nada que escribir, el mensaje sale del buzón.
      if (resultado.clasificacion === "duplicado" || resultado.clasificacion === "rechazado") {
        await marcarProcesado(ctx.directory, {
          mensaje_id,
          clasificacion: resultado.clasificacion,
          id_contrato: resultado.id_contrato_existente,
          motivo: resultado.motivo,
          ts: new Date().toISOString(),
        })
      }
      const revision = resultado.requiere_revision.length > 0 ? `, revisar: ${resultado.requiere_revision.join(", ")}` : ""
      return { data: resultado, resumen: `${resultado.clasificacion}${revision}` }
    }),
})

export const registrar = herramienta({
  description:
    "Escribe o actualiza el contrato en el maestro, lo archiva en SharePoint y deja historial; se niega si hay campos en revisión y confirmado no es true.",
  args: {
    mensaje_id: mensajeIdSchema,
    contrato: contratoSchema.describe("Contrato extraído, con los valores que el usuario confirmó si hubo revisión"),
    confirmado: z
      .boolean()
      .optional()
      .describe("true SOLO si el usuario confirmó explícitamente en su último mensaje los campos en revisión"),
  },
  execute: ({ mensaje_id, contrato, confirmado }, ctx) =>
    ejecutar(ctx, "contratos_registrar", mensaje_id, async () => {
      const resultado = await registrarContrato(ctx.directory, mensaje_id, contrato, confirmado === true)
      return {
        data: resultado,
        resumen: `${resultado.accion} ${resultado.id_contrato} -> ${resultado.ruta_archivo}`,
      }
    }),
})

export const alertas = herramienta({
  description:
    "Genera out/alertas.md con los contratos que vencen en 60 días o menos, las pólizas exigidas que no están vigentes y lo registrado desde el corte del maestro (2026-05-30).",
  args: {
    hoy: fechaIsoSchema.describe("Fecha de referencia YYYY-MM-DD; se pasa explícita para que el reporte sea reproducible"),
  },
  execute: ({ hoy }, ctx) =>
    ejecutar(ctx, "contratos_alertas", null, async () => {
      const reporte = await generarAlertas(ctx.directory, hoy)
      return {
        data: reporte,
        resumen: `${reporte.vencen.length} por vencer, ${reporte.polizas_pendientes.length} pólizas pendientes, ${reporte.registrados_desde_corte.length} desde el corte`,
      }
    }),
})

/** Identidad tipada: deja que TypeScript infiera los args de `execute` desde el esquema zod. */
function herramienta<A extends ToolArgsShape>(definicion: ToolDefinition<A>): ToolDefinition<A> {
  return definicion
}

/**
 * Único punto donde se atrapan los errores: los convierte en `{ ok: false, error }` legible y deja
 * la línea de RN7 en out/log.jsonl. Si el propio log falla, la respuesta al agente no se pierde.
 */
async function ejecutar<T>(
  ctx: ToolContext,
  nombre: string,
  mensajeId: string | null,
  fn: () => Promise<{ data: T; resumen: string }>,
): Promise<string> {
  let respuesta: string
  let entrada: { ok: boolean; resumen: string }
  try {
    const { data, resumen } = await fn()
    respuesta = JSON.stringify({ ok: true, data })
    entrada = { ok: true, resumen }
  } catch (err) {
    const error = err instanceof Error ? err.message : "error desconocido al ejecutar la herramienta"
    respuesta = JSON.stringify({ ok: false, error })
    entrada = { ok: false, resumen: error }
  }
  try {
    await registrarLog(ctx.directory, { herramienta: nombre, mensaje_id: mensajeId, ...entrada, sessionId: ctx.sessionId })
  } catch {
    // El log es auditoría, no parte del resultado: un disco lleno no debe tumbar la herramienta.
  }
  return respuesta
}
