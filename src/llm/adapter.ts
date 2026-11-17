import type { z } from "zod"

export type ParteMensaje =
  | { tipo: "texto"; texto: string }
  | { tipo: "llamada_herramienta"; id: string; nombre: string; argumentos: unknown }
  | { tipo: "resultado_herramienta"; id: string; nombre: string; resultado: string }

export interface Mensaje {
  rol: "user" | "assistant"
  partes: ParteMensaje[]
}

export interface HerramientaLLM {
  nombre: string
  descripcion: string
  esquema: z.ZodTypeAny
}

export interface RespuestaLLM {
  texto: string | null
  llamadasHerramientas: Array<{ id: string; nombre: string; argumentos: unknown }>
  detenidoPor: "fin_turno" | "tool_use" | "max_tokens" | "otro"
  uso: { tokensEntrada: number; tokensSalida: number }
}

/**
 * Interfaz propia del proveedor de modelo de lenguaje. Cambiar de proveedor implica
 * escribir una nueva implementación de esta interfaz; el ciclo del agente (src/server.ts)
 * no debe modificarse.
 */
export interface AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], systemPrompt: string, herramientas: HerramientaLLM[]): Promise<RespuestaLLM>
}
