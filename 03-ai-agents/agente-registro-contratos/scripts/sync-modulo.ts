/**
 * Regenera modulo/agent.md y modulo/skill/registro-contratos/SKILL.md a partir de las
 * fuentes canónicas (agent/prompt.md y src/knowledge/registro-contratos.md), agregándoles
 * solo el frontmatter que exige el empaquetado del módulo. El cuerpo nunca se edita a mano
 * en modulo/ para que no se convierta en una copia divergente de la app principal.
 *
 * modulo/tools/contratos.ts, en cambio, no se genera: es un archivo fijo que reexporta
 * src/tools/contratos.ts, así que no hay copia que pueda divergir (y, a diferencia de un
 * symlink, funciona igual en Windows y lo verifica el typecheck).
 *
 *   npm run sync:modulo            regenera los archivos
 *   npm run sync:modulo -- --check falla (exit 1) si modulo/ no coincide con las fuentes
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
      `description: ${JSON.stringify("Agente que registra los contratos vigentes de Periferia desde un buzón único: extrae los datos, detecta duplicados y otrosíes, archiva y alimenta el maestro, y alerta vencimientos y pólizas pendientes.")}`,
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
      "",
      prompt,
    ].join("\n") + "\n"
  const destinos: Array<[string, string]> = [[path.join(ROOT, "modulo", "agent.md"), agentMd]]

  const conocimiento = (await fs.readFile(path.join(ROOT, "src", "knowledge", "registro-contratos.md"), "utf-8")).trimEnd()
  const skillMd =
    [
      "---",
      "name: registro-contratos",
      `description: ${JSON.stringify("Conocimiento del proceso de registro de contratos vigentes de Periferia: clasificación nuevo/actualización/duplicado/rechazado, umbral de confianza, estructura de archivo y alertas.")}`,
      "---",
      "",
      conocimiento,
    ].join("\n") + "\n"
  destinos.push([path.join(ROOT, "modulo", "skill", "registro-contratos", "SKILL.md"), skillMd])

  if (process.argv.includes("--check")) {
    const desactualizados: string[] = []
    for (const [ruta, contenido] of destinos) {
      const actual = await fs.readFile(ruta, "utf-8").catch(() => null)
      if (actual !== contenido) desactualizados.push(path.relative(ROOT, ruta))
    }
    if (desactualizados.length > 0) {
      console.error(`modulo/ desactualizado: ${desactualizados.join(", ")}. Corre npm run sync:modulo`)
      process.exitCode = 1
      return
    }
    console.log("modulo/ coincide con agent/prompt.md y src/knowledge/registro-contratos.md")
    return
  }

  for (const [ruta, contenido] of destinos) {
    await fs.mkdir(path.dirname(ruta), { recursive: true })
    await fs.writeFile(ruta, contenido, "utf-8")
  }
  console.log("Regenerados: modulo/agent.md, modulo/skill/registro-contratos/SKILL.md")
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
