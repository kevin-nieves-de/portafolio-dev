import type { AdaptadorLLM, Mensaje, RespuestaLLM } from "../llm/adapter.js"
import type { ToolContext } from "../tools/types.js"
import { registrarLog } from "../tools/lib/log.js"
import type { HerramientaRegistrada } from "./tool-registry.js"

export interface ResumenLlamadaHerramienta {
  nombre: string
  argumentos: unknown
  ok: boolean
  resumen: string
}

export interface ResultadoTurno {
  reply: string
  toolCalls: ResumenLlamadaHerramienta[]
  needsConfirmation: boolean
  tokensConsumidos: number
}

export interface OpcionesTurno {
  directory: string
  sessionId: string
  adaptador: AdaptadorLLM
  systemPrompt: string
  herramientas: HerramientaRegistrada[]
  maxIteraciones: number
  /** Tope por llamada al modelo (no por turno: un turno de buzón encadena ~20 llamadas). */
  timeoutLlmMs: number
}

/**
 * CA1-CA5: ciclo prompt -> modelo -> herramientas -> respuesta, con tope de iteraciones,
 * validación de argumentos, y sin dejar que un error de herramienta o del proveedor mate la sesión.
 */
export async function ejecutarTurno(historial: Mensaje[], mensajeUsuario: string, opciones: OpcionesTurno): Promise<ResultadoTurno> {
  historial.push({ rol: "user", partes: [{ tipo: "texto", texto: mensajeUsuario }] })

  const herramientasLLM = opciones.herramientas.map((h) => ({
    nombre: h.nombre,
    descripcion: h.definicion.description,
    esquema: h.esquemaZod,
  }))

  const toolCalls: ResumenLlamadaHerramienta[] = []
  let ultimaRespuesta: RespuestaLLM | null = null
  let tokensConsumidos = 0

  for (let iteracion = 0; iteracion < opciones.maxIteraciones; iteracion++) {
    let respuesta: RespuestaLLM
    try {
      respuesta = await conTimeout(
        opciones.adaptador.enviar(historial, opciones.systemPrompt, herramientasLLM),
        opciones.timeoutLlmMs,
        `el proveedor de modelo de lenguaje no respondió en ${Math.round(opciones.timeoutLlmMs / 1000)} s`,
      )
    } catch (err) {
      // CA5: el error del proveedor llega al chat junto con lo que alcanzó a ejecutarse en el turno,
      // para que la analista sepa qué quedó registrado antes del corte.
      const motivo = err instanceof Error ? err.message : "error desconocido del proveedor"
      const hecho = toolCalls.length > 0 ? ` Antes del corte se ejecutaron ${toolCalls.length} llamadas a herramientas (ver abajo).` : ""
      return {
        reply: `No pude completar la solicitud: ${motivo}.${hecho} La sesión sigue activa; puedes pedirme que continúe.`,
        toolCalls,
        needsConfirmation: false,
        tokensConsumidos,
      }
    }
    ultimaRespuesta = respuesta
    tokensConsumidos += respuesta.uso.tokensEntrada + respuesta.uso.tokensSalida

    const partesAssistant: Mensaje["partes"] = []
    if (respuesta.texto) partesAssistant.push({ tipo: "texto", texto: respuesta.texto })
    for (const llamada of respuesta.llamadasHerramientas) {
      partesAssistant.push({ tipo: "llamada_herramienta", id: llamada.id, nombre: llamada.nombre, argumentos: llamada.argumentos })
    }
    historial.push({ rol: "assistant", partes: partesAssistant })

    if (respuesta.llamadasHerramientas.length === 0) {
      return {
        reply: respuesta.texto ?? "",
        toolCalls,
        needsConfirmation: detectarPreguntaDeConfirmacion(respuesta.texto),
        tokensConsumidos,
      }
    }

    const partesResultado: Mensaje["partes"] = []
    for (const llamada of respuesta.llamadasHerramientas) {
      const { resultadoTexto, ok, resumen } = await ejecutarLlamada(opciones, llamada)
      toolCalls.push({ nombre: llamada.nombre, argumentos: llamada.argumentos, ok, resumen })
      partesResultado.push({ tipo: "resultado_herramienta", id: llamada.id, nombre: llamada.nombre, resultado: resultadoTexto })
    }
    historial.push({ rol: "user", partes: partesResultado })
  }

  return {
    reply:
      ultimaRespuesta?.texto ||
      "Se alcanzó el tope de iteraciones configurado para este turno. Este es el resumen de lo realizado hasta ahora; puedes pedirme que continúe.",
    toolCalls,
    needsConfirmation: false,
    tokensConsumidos,
  }
}

async function ejecutarLlamada(
  opciones: OpcionesTurno,
  llamada: { id: string; nombre: string; argumentos: unknown },
): Promise<{ resultadoTexto: string; ok: boolean; resumen: string }> {
  const herramienta = opciones.herramientas.find((h) => h.nombre === llamada.nombre)
  if (!herramienta) {
    return rechazarAntesDeEjecutar(opciones, llamada, `herramienta desconocida: "${llamada.nombre}"`)
  }

  const validacion = herramienta.esquemaZod.safeParse(llamada.argumentos)
  if (!validacion.success) {
    const detalle = validacion.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")
    return rechazarAntesDeEjecutar(opciones, llamada, `argumentos inválidos para ${llamada.nombre}: ${detalle}`)
  }

  const ctx: ToolContext = { directory: opciones.directory, sessionId: opciones.sessionId }
  const resultadoTexto = await herramienta.definicion.execute(validacion.data, ctx)
  return { resultadoTexto, ...interpretarResultado(resultadoTexto) }
}

/** Las llamadas que no llegan a la herramienta las registra el ciclo; las demás, la herramienta misma (RN7). */
async function rechazarAntesDeEjecutar(
  opciones: OpcionesTurno,
  llamada: { nombre: string; argumentos: unknown },
  mensaje: string,
): Promise<{ resultadoTexto: string; ok: boolean; resumen: string }> {
  const mensajeId = extraerMensajeId(llamada.argumentos)
  await registrarLog(opciones.directory, {
    herramienta: llamada.nombre,
    mensaje_id: mensajeId,
    ok: false,
    resumen: mensaje,
    sessionId: opciones.sessionId,
  })
  return { resultadoTexto: JSON.stringify({ ok: false, error: mensaje }), ok: false, resumen: mensaje }
}

function extraerMensajeId(argumentos: unknown): string | null {
  if (argumentos && typeof argumentos === "object" && "mensaje_id" in argumentos) {
    const valor = (argumentos as { mensaje_id: unknown }).mensaje_id
    return typeof valor === "string" ? valor : null
  }
  return null
}

function interpretarResultado(json: string): { ok: boolean; resumen: string } {
  try {
    const data = JSON.parse(json) as { ok: boolean; data?: unknown; error?: string }
    if (data.ok) return { ok: true, resumen: resumenCompacto(data.data) }
    return { ok: false, resumen: data.error ?? "error sin detalle" }
  } catch {
    return { ok: false, resumen: "la herramienta no devolvió JSON válido" }
  }
}

function resumenCompacto(data: unknown): string {
  const texto = JSON.stringify(data)
  return texto.length > 300 ? texto.slice(0, 300) + "…" : texto
}

/** CA3: heurística para resaltar en el front cuando el turno terminó con una pregunta. */
function detectarPreguntaDeConfirmacion(texto: string | null): boolean {
  if (!texto) return false
  return texto.trim().endsWith("?")
}

function conTimeout<T>(promesa: Promise<T>, ms: number, mensaje: string): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined
  const limite = new Promise<never>((_, reject) => {
    temporizador = setTimeout(() => reject(new Error(mensaje)), ms)
  })
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador))
}
