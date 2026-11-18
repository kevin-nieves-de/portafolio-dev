import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages"
import { z } from "zod"

import type { AdaptadorLLM, HerramientaLLM, Mensaje, ParteMensaje, RespuestaLLM } from "./adapter.js"

export class AdaptadorAnthropic implements AdaptadorLLM {
  readonly proveedor = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic

  constructor(apiKey: string, modelo: string) {
    this.cliente = new Anthropic({ apiKey })
    this.modelo = modelo
  }

  async enviar(mensajes: Mensaje[], systemPrompt: string, herramientas: HerramientaLLM[]): Promise<RespuestaLLM> {
    // API beta solo por `fallbacks`: si el clasificador de seguridad declina el turno, el servidor
    // lo reintenta en otro modelo dentro de la misma llamada en vez de dejar el chat sin respuesta.
    const respuesta = await this.cliente.beta.messages.create({
      model: this.modelo,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Caché automática del prefijo estable (herramientas + system prompt + historial): cada
      // iteración del ciclo reenvía todo, así que solo se paga completo lo nuevo de cada vuelta.
      cache_control: { type: "ephemeral" },
      system: systemPrompt,
      messages: mensajes.map(aMensajeAnthropic),
      tools: herramientas.map(aHerramientaAnthropic),
    })

    const llamadasHerramientas: RespuestaLLM["llamadasHerramientas"] = []
    let texto: string | null = null
    for (const bloque of respuesta.content) {
      if (bloque.type === "text") {
        texto = (texto ?? "") + bloque.text
      } else if (bloque.type === "tool_use") {
        llamadasHerramientas.push({ id: bloque.id, nombre: bloque.name, argumentos: bloque.input })
      }
    }

    if (respuesta.stop_reason === "refusal" && !texto && llamadasHerramientas.length === 0) {
      texto = "El modelo declinó responder esta solicitud. Reformúlala o continúa con otro mensaje del buzón."
    }

    return {
      texto,
      llamadasHerramientas,
      detenidoPor:
        respuesta.stop_reason === "tool_use"
          ? "tool_use"
          : respuesta.stop_reason === "end_turn"
            ? "fin_turno"
            : respuesta.stop_reason === "max_tokens"
              ? "max_tokens"
              : "otro",
      uso: {
        tokensEntrada: respuesta.usage.input_tokens,
        tokensSalida: respuesta.usage.output_tokens,
      },
    }
  }
}

function aHerramientaAnthropic(herramienta: HerramientaLLM): BetaTool {
  const esquema = aJsonSchema(herramienta.esquema)
  return {
    name: herramienta.nombre,
    description: herramienta.descripcion,
    input_schema: { type: "object", ...esquema },
  }
}

function aMensajeAnthropic(mensaje: Mensaje): BetaMessageParam {
  return {
    role: mensaje.rol,
    content: mensaje.partes.map(aBloqueAnthropic),
  }
}

type BloqueContenidoAnthropic = BetaTextBlockParam | BetaToolUseBlockParam | BetaToolResultBlockParam

function aBloqueAnthropic(parte: ParteMensaje): BloqueContenidoAnthropic {
  if (parte.tipo === "texto") {
    return { type: "text", text: parte.texto }
  }
  if (parte.tipo === "llamada_herramienta") {
    const bloque: BetaToolUseBlockParam = { type: "tool_use", id: parte.id, name: parte.nombre, input: parte.argumentos }
    return bloque
  }
  const resultado: BetaToolResultBlockParam = { type: "tool_result", tool_use_id: parte.id, content: parte.resultado }
  return resultado
}

/** JSON Schema de los argumentos tal como los recibe la herramienta (io: "input"), sin $ref. */
function aJsonSchema(esquema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(esquema, { target: "draft-7", io: "input", reused: "inline" }) as Record<string, unknown>
}
