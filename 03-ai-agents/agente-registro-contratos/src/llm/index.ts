import type { AdaptadorLLM } from "./adapter.js"
import { AdaptadorAnthropic } from "./anthropic.js"
import { AdaptadorGemini } from "./gemini.js"

/** Fábrica del adaptador LLM según LLM_PROVIDER. Agregar un proveedor nuevo no debe tocar el ciclo del agente. */
export function crearAdaptadorLLM(): AdaptadorLLM {
  const proveedor = process.env.LLM_PROVIDER ?? "anthropic"

  if (proveedor === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY")
    }
    const modelo = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5"
    return new AdaptadorAnthropic(apiKey, modelo)
  }

  if (proveedor === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error("Falta la variable de entorno GEMINI_API_KEY")
    }
    const modelo = process.env.GEMINI_MODEL ?? "gemini-2.5-flash"
    return new AdaptadorGemini(apiKey, modelo)
  }

  throw new Error(`Proveedor LLM no soportado: "${proveedor}". Implementaciones disponibles: anthropic, gemini`)
}
