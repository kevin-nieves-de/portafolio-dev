/**
 * Regenera modulo/agent.md y modulo/skill/registro-contratos/SKILL.md a partir de las
 * fuentes canónicas (agent/prompt.md y src/knowledge/registro-contratos.md), agregándoles
 * solo el frontmatter que exige el empaquetado del módulo. El cuerpo nunca se edita a mano
 * en modulo/ para que no se convierta en una copia divergente de la app principal.
 *
 * modulo/tools/contratos.ts, en cambio, es un symlink real a src/tools/contratos.ts: no
 * necesita sincronización porque es literalmente el mismo archivo.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function main(): Promise<void> {
  const prompt = (await fs.readFile(path.join(ROOT, "agent", "prompt.md"), "utf-8")).trimEnd()
  const agentMd =
    [
      "---",
      "description: Agente que registra los contratos vigentes de Periferia desde un buzón único: extrae los datos, detecta duplicados y otrosíes, archiva y alimenta el maestro, y alerta vencimientos y pólizas pendientes.",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
      "",
      prompt,
    ].join("\n") + "\n"
  await fs.mkdir(path.join(ROOT, "modulo"), { recursive: true })
  await fs.writeFile(path.join(ROOT, "modulo", "agent.md"), agentMd, "utf-8")

  const conocimiento = (await fs.readFile(path.join(ROOT, "src", "knowledge", "registro-contratos.md"), "utf-8")).trimEnd()
  const skillMd =
    [
      "---",
      "name: registro-contratos",
      "description: Conocimiento del proceso de registro de contratos vigentes de Periferia: clasificación nuevo/actualización/duplicado/rechazado, umbral de confianza, estructura de archivo y alertas.",
      "---",
      "",
      conocimiento,
    ].join("\n") + "\n"
  const skillDir = path.join(ROOT, "modulo", "skill", "registro-contratos")
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMd, "utf-8")

  console.log("Regenerados: modulo/agent.md, modulo/skill/registro-contratos/SKILL.md")
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
