import { promises as fs } from "node:fs"
import path from "node:path"
import { ensureDir, outDir } from "./rutas.js"

export interface EntradaLog {
  herramienta: string
  mensaje_id: string | null
  ok: boolean
  resumen: string
  /** Solo presente cuando la llamada viene del chat; demo.ts no tiene sesión. */
  sessionId?: string
}

/**
 * RN7 + CA4: un único log global en out/log.jsonl. Lo escriben las herramientas (para que demo.ts,
 * que no pasa por el ciclo del agente, también deje rastro) y el ciclo del agente solo para las
 * llamadas que rechaza antes de ejecutarlas (herramienta desconocida o argumentos inválidos).
 */
export async function registrarLog(directory: string, entrada: EntradaLog): Promise<void> {
  await ensureDir(outDir(directory))
  const linea = JSON.stringify({ ts: new Date().toISOString(), ...entrada })
  await fs.appendFile(path.join(outDir(directory), "log.jsonl"), linea + "\n", "utf-8")
}
