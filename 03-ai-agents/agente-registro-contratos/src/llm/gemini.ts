import { z } from "zod"

import type { AdaptadorLLM, HerramientaLLM, Mensaje, ParteMensaje, RespuestaLLM } from "./adapter.js"

const URL_BASE = "https://generativelanguage.googleapis.com/v1beta"

/**
 * Adaptador para la API de Google Gemini (generateContent, v1beta).
 *
 * Diferencias con Anthropic que este adaptador absorbe para que el ciclo del agente
 * no cambie:
 *  - roles: Gemini usa "model" en vez de "assistant".
 *  - las tool calls (`functionCall`) y sus resultados (`functionResponse`) no llevan id;
 *    se emparejan por nombre y orden. El id que exige nuestra interfaz se sintetiza aquí.
 *  - `functionResponse.response` debe ser un objeto; nuestras herramientas devuelven
 *    un string JSON, así que se parsea.
 *  - el esquema de parámetros es un subconjunto de OpenAPI 3.0: no admite `$schema`
 *    ni `additionalProperties`, que `z.toJSONSchema` sí emite.
 *  - se envía `thinkingBudget: 0`: el LLM aquí solo orquesta tool-calling, no necesita
 *    "pensar" y así el turno no se acerca al timeout del servidor. (Gemini 2.5 Pro exige
 *    mínimo 128; si se cambia el modelo a Pro hay que subir este valor.)
 */
export class AdaptadorGemini implements AdaptadorLLM {
  readonly proveedor = "gemini"
  readonly modelo: string
  private readonly apiKey: string

  constructor(apiKey: string, modelo: string) {
    this.apiKey = apiKey
    this.modelo = modelo
  }

  async enviar(mensajes: Mensaje[], systemPrompt: string, herramientas: HerramientaLLM[]): Promise<RespuestaLLM> {
    const cuerpo: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: mensajes.map(aContenidoGemini),
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }
    if (herramientas.length > 0) {
      cuerpo.tools = [{ functionDeclarations: herramientas.map(aFunctionDeclaration) }]
      cuerpo.toolConfig = { functionCallingConfig: { mode: "AUTO" } }
    }

    const respuesta = await this.solicitar(cuerpo)
    const datos = (await respuesta.json()) as RespuestaGenerateContent
    const candidato = datos.candidates?.[0]
    if (!candidato?.content?.parts) {
      const razon = candidato?.finishReason ?? datos.promptFeedback?.blockReason ?? "sin candidatos"
      throw new Error(`Gemini no devolvió contenido (${razon})`)
    }

    const llamadasHerramientas: RespuestaLLM["llamadasHerramientas"] = []
    let texto: string | null = null
    let indice = 0
    for (const parte of candidato.content.parts) {
      if (parte.functionCall) {
        llamadasHerramientas.push({
          id: `gemini-${indice++}-${parte.functionCall.name}`,
          nombre: parte.functionCall.name,
          argumentos: parte.functionCall.args ?? {},
        })
      } else if (typeof parte.text === "string" && parte.thought !== true) {
        texto = (texto ?? "") + parte.text
      }
    }

    const uso = datos.usageMetadata
    return {
      texto,
      llamadasHerramientas,
      detenidoPor:
        llamadasHerramientas.length > 0
          ? "tool_use"
          : candidato.finishReason === "MAX_TOKENS"
            ? "max_tokens"
            : candidato.finishReason === "STOP"
              ? "fin_turno"
              : "otro",
      uso: {
        tokensEntrada: uso?.promptTokenCount ?? 0,
        tokensSalida: (uso?.candidatesTokenCount ?? 0) + (uso?.thoughtsTokenCount ?? 0),
      },
    }
  }

  /**
   * El plan gratuito limita las solicitudes por minuto y un turno de buzón encadena ~20 llamadas.
   * Ante 429 (cuota) o 503 (saturado) espera lo que sugiere Google (`retryDelay`) y reintenta.
   * Las esperas están acotadas para caber dentro del timeout por llamada del ciclo (120 s); si la
   * espera sugerida es mayor (p. ej. cuota diaria agotada) falla de una vez con un mensaje claro.
   */
  private async solicitar(cuerpo: Record<string, unknown>): Promise<Response> {
    for (let intento = 0; ; intento++) {
      const respuesta = await fetch(`${URL_BASE}/models/${this.modelo}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(cuerpo),
      })
      if (respuesta.ok) return respuesta

      const detalle = await respuesta.text()
      const reintentable = respuesta.status === 429 || respuesta.status === 503
      const espera = esperaSugeridaMs(detalle, intento)
      if (!reintentable || intento >= MAX_REINTENTOS || espera > ESPERA_MAXIMA_MS) {
        throw new Error(mensajeDeError(respuesta.status, detalle))
      }
      await new Promise((resolver) => setTimeout(resolver, espera))
    }
  }
}

const MAX_REINTENTOS = 3
const ESPERA_MAXIMA_MS = 30_000

/** Usa el `retryDelay` que devuelve Google ("17s"); si no viene, espera 5 s, 10 s, 20 s. */
function esperaSugeridaMs(detalle: string, intento: number): number {
  const sugerida = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(detalle)?.[1]
  return sugerida !== undefined ? Math.ceil(Number(sugerida) * 1000) + 500 : 5_000 * 2 ** intento
}

function mensajeDeError(estado: number, detalle: string): string {
  if (estado === 429) {
    return "Gemini alcanzó el límite de solicitudes de su plan gratuito (429). Espera un minuto y pídeme que continúe; si persiste, la cuota diaria se agotó"
  }
  if (estado === 503) return "Gemini está saturado en este momento (503). Intenta de nuevo en un minuto"
  return `Gemini respondió ${estado}: ${detalle.slice(0, 300)}`
}

interface ParteGemini {
  text?: string
  thought?: boolean
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface ContenidoGemini {
  role: "user" | "model"
  parts: ParteGemini[]
}

interface RespuestaGenerateContent {
  candidates?: Array<{ content?: { role?: string; parts?: ParteGemini[] }; finishReason?: string }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
}

function aFunctionDeclaration(herramienta: HerramientaLLM): Record<string, unknown> {
  const esquema = aJsonSchema(herramienta.esquema)
  return {
    name: herramienta.nombre,
    description: herramienta.descripcion,
    parameters: limpiarEsquema({ type: "object", ...esquema }),
  }
}

/** Gemini acepta un subconjunto de OpenAPI 3.0: quita las claves que `z.toJSONSchema` agrega y que la API rechaza. */
function limpiarEsquema(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(limpiarEsquema)
  if (nodo !== null && typeof nodo === "object") {
    const salida: Record<string, unknown> = {}
    for (const [clave, valor] of Object.entries(nodo)) {
      if (clave === "$schema" || clave === "additionalProperties" || clave === "$defs" || clave === "definitions") {
        continue
      }
      salida[clave] = limpiarEsquema(valor)
    }
    return salida
  }
  return nodo
}

function aContenidoGemini(mensaje: Mensaje): ContenidoGemini {
  return {
    role: mensaje.rol === "assistant" ? "model" : "user",
    parts: mensaje.partes.map(aParteGemini),
  }
}

function aParteGemini(parte: ParteMensaje): ParteGemini {
  if (parte.tipo === "texto") {
    return { text: parte.texto }
  }
  if (parte.tipo === "llamada_herramienta") {
    return { functionCall: { name: parte.nombre, args: (parte.argumentos ?? {}) as Record<string, unknown> } }
  }
  return { functionResponse: { name: parte.nombre, response: aObjetoRespuesta(parte.resultado) } }
}

/** `functionResponse.response` debe ser un objeto JSON; nuestras herramientas devuelven un string. */
function aObjetoRespuesta(resultado: string): Record<string, unknown> {
  try {
    const analizado: unknown = JSON.parse(resultado)
    if (analizado !== null && typeof analizado === "object" && !Array.isArray(analizado)) {
      return analizado as Record<string, unknown>
    }
    return { resultado: analizado }
  } catch {
    return { resultado }
  }
}

/** JSON Schema de los argumentos tal como los recibe la herramienta (io: "input"), sin $ref. */
function aJsonSchema(esquema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(esquema, { target: "draft-7", io: "input", reused: "inline" }) as Record<string, unknown>
}
