import Anthropic from "@anthropic-ai/sdk"
import type {
  MessageParam,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages"
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
    const respuesta = await this.cliente.messages.create({
      model: this.modelo,
      max_tokens: 4096,
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

function aHerramientaAnthropic(herramienta: HerramientaLLM): Tool {
  const esquema = aJsonSchema(herramienta.esquema)
  return {
    name: herramienta.nombre,
    description: herramienta.descripcion,
    input_schema: { type: "object", ...esquema },
  }
}

function aMensajeAnthropic(mensaje: Mensaje): MessageParam {
  return {
    role: mensaje.rol,
    content: mensaje.partes.map(aBloqueAnthropic),
  }
}

type BloqueContenidoAnthropic = TextBlockParam | ToolUseBlockParam | ToolResultBlockParam

function aBloqueAnthropic(parte: ParteMensaje): BloqueContenidoAnthropic {
  if (parte.tipo === "texto") {
    return { type: "text", text: parte.texto }
  }
  if (parte.tipo === "llamada_herramienta") {
    const bloque: ToolUseBlockParam = { type: "tool_use", id: parte.id, name: parte.nombre, input: parte.argumentos }
    return bloque
  }
  const resultado: ToolResultBlockParam = { type: "tool_result", tool_use_id: parte.id, content: parte.resultado }
  return resultado
}

/** JSON Schema de los argumentos tal como los recibe la herramienta (io: "input"), sin $ref. */
function aJsonSchema(esquema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(esquema, { target: "draft-7", io: "input", reused: "inline" }) as Record<string, unknown>
}
