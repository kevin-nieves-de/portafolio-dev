/**
 * demo.ts (PRD §6.6): procesa los 6 mensajes del buzón llamando directamente a las herramientas,
 * sin modelo de lenguaje ni API key. Usa el mismo registro (`contratos_<export>`) y la misma
 * validación zod de argumentos que el ciclo del agente, así que prueba exactamente lo que ve el modelo.
 *
 *   npm run demo
 *
 * Determinista salvo timestamps: vacía out/ al inicio (conserva out/.gitkeep).
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { construirRegistroHerramientas } from "./src/agent/tool-registry.js"
import type { Contrato } from "./src/tools/lib/esquemas.js"
import type { ResultadoValidacion } from "./src/tools/lib/validacion.js"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const HOY = "2026-09-03"
const herramientas = construirRegistroHerramientas()

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }

/** Igual que `ejecutarLlamada` en src/agent/loop.ts: valida con zod y luego ejecuta. */
async function invocar<T>(nombre: string, args: unknown): Promise<Respuesta<T>> {
  const herramienta = herramientas.find((h) => h.nombre === nombre)
  if (!herramienta) return { ok: false, error: `herramienta desconocida: ${nombre}` }
  const validacion = herramienta.esquemaZod.safeParse(args)
  if (!validacion.success) {
    const detalle = validacion.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")
    return { ok: false, error: `argumentos inválidos: ${detalle}` }
  }
  return JSON.parse(await herramienta.definicion.execute(validacion.data, { directory: ROOT, sessionId: "demo" })) as Respuesta<T>
}

interface MensajeBuzon {
  id: string
  asunto: string
  tiene_contrato: boolean
  clasificacion: string | null
  motivo: string | null
}
interface ResultadoRegistro {
  id_contrato: string
  accion: string
  ruta_archivo: string
  estado_poliza: string
}
interface ReporteAlertas {
  ruta: string
  vencen: Array<{ id_contrato: string; fecha_fin: string; dias_restantes: number }>
  polizas_pendientes: Array<{ id_contrato: string; estado_poliza: string }>
  registrados_desde_corte: Array<{ id_contrato: string; accion: string }>
}

const linea = (texto = ""): void => console.log(texto)
const ok = (texto: string): void => console.log(`  ok  ${texto}`)
const x = (texto: string): void => console.log(`  x   ${texto}`)

async function procesarMensaje(mensaje: MensajeBuzon, pendientes: Map<string, Contrato>): Promise<void> {
  linea(`\n${mensaje.id} — ${mensaje.asunto}`)
  if (mensaje.clasificacion === "rechazado") {
    ok(`clasificación: rechazado (${mensaje.motivo ?? ""}) — acción: ninguna, sale del buzón`)
    return
  }

  const extraccion = await invocar<Contrato>("contratos_extraer", { mensaje_id: mensaje.id })
  if (!extraccion.ok) return x(`extraer: ${extraccion.error}`)
  const contrato = extraccion.data

  const validacion = await invocar<ResultadoValidacion>("contratos_validar", { mensaje_id: mensaje.id, contrato })
  if (!validacion.ok) return x(`validar: ${validacion.error}`)
  const v = validacion.data
  const revision = v.requiere_revision.length > 0 ? v.requiere_revision.join(", ") : "ninguno"
  ok(`clasificación: ${v.clasificacion}${v.id_contrato_existente ? ` (existente: ${v.id_contrato_existente})` : ""}`)
  ok(`campos en revisión: ${revision}`)
  for (const [campo, motivo] of Object.entries(v.motivos_revision)) linea(`        · ${campo}: ${motivo}`)
  if (v.diferencias) linea(`        · diferencias: ${JSON.stringify(v.diferencias)}`)
  for (const aviso of v.avisos) linea(`        · aviso: ${aviso}`)

  if (v.clasificacion === "duplicado" || v.clasificacion === "rechazado") {
    ok(`acción: ninguna (${v.motivo ?? ""})`)
    return
  }

  const registro = await invocar<ResultadoRegistro>("contratos_registrar", { mensaje_id: mensaje.id, contrato })
  if (registro.ok) {
    const r = registro.data
    ok(`acción: ${r.accion} ${r.id_contrato}, póliza ${r.estado_poliza}, archivado en ${r.ruta_archivo}`)
  } else {
    ok(`acción: SIN REGISTRAR en la primera pasada -> ${registro.error}`)
    pendientes.set(mensaje.id, contrato)
  }
}

/** Vacía out/ para que la demo sea determinista, sin borrar out/.gitkeep (que está versionado). */
async function limpiarSalidas(): Promise<void> {
  const out = path.join(ROOT, "out")
  await fs.mkdir(out, { recursive: true })
  for (const entrada of await fs.readdir(out)) {
    if (entrada !== ".gitkeep") await fs.rm(path.join(out, entrada), { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await limpiarSalidas()

  linea("=== 1. Buzón pendiente ===")
  const buzon = await invocar<{ mensajes: MensajeBuzon[] }>("contratos_leer_buzon", {})
  if (!buzon.ok) throw new Error(buzon.error)
  for (const m of buzon.data.mensajes) linea(`  ${m.id}  contrato=${m.tiene_contrato ? "sí" : "no"}  ${m.asunto}`)

  linea("\n=== 2. Primera pasada: extraer -> validar -> registrar (sin confirmar) ===")
  const pendientes = new Map<string, Contrato>()
  for (const mensaje of buzon.data.mensajes) await procesarMensaje(mensaje, pendientes)

  linea("\n=== 3. Segunda pasada: el usuario confirma los campos en revisión ===")
  for (const [mensajeId, contrato] of pendientes) {
    linea(`\n${mensajeId} — usuario: "confirmo el valor ${contrato.valor.valor} y la fecha fin ${contrato.fecha_fin.valor}"`)
    const r = await invocar<ResultadoRegistro>("contratos_registrar", { mensaje_id: mensajeId, contrato, confirmado: true })
    if (r.ok) ok(`acción: ${r.data.accion} ${r.data.id_contrato}, póliza ${r.data.estado_poliza}, archivado en ${r.data.ruta_archivo}`)
    else x(r.error)
  }

  const restante = await invocar<{ mensajes: MensajeBuzon[] }>("contratos_leer_buzon", {})
  linea(`\nMensajes pendientes tras procesar: ${restante.ok ? restante.data.mensajes.length : restante.error}`)

  linea(`\n=== 4. Alertas al ${HOY} ===`)
  const reporte = await invocar<ReporteAlertas>("contratos_alertas", { hoy: HOY })
  if (reporte.ok) {
    const a = reporte.data
    ok(`vencen en ≤ 60 días: ${a.vencen.map((c) => `${c.id_contrato} (${c.fecha_fin}, ${c.dias_restantes} d)`).join(", ") || "ninguno"}`)
    ok(`pólizas no vigentes: ${a.polizas_pendientes.map((p) => `${p.id_contrato} (${p.estado_poliza})`).join(", ") || "ninguna"}`)
    ok(`desde el corte: ${a.registrados_desde_corte.map((r) => `${r.id_contrato} (${r.accion})`).join(", ") || "ninguno"}`)
    ok(`reporte: ${a.ruta}`)
  } else {
    x(reporte.error)
  }

  linea("\n=== 5. Manejo de errores (HU-6): cada caso falla con mensaje legible y el lote sigue ===")
  const contratoMsg001 = await invocar<Contrato>("contratos_extraer", { mensaje_id: "msg-001" })
  if (!contratoMsg001.ok) throw new Error(contratoMsg001.error)
  const base = contratoMsg001.data
  const casos: Array<[string, string, unknown]> = [
    ["mensaje inexistente", "contratos_extraer", { mensaje_id: "msg-999" }],
    ["ruta fuera del buzón", "contratos_extraer", { mensaje_id: "../fixtures" }],
    ["fecha inválida", "contratos_validar", { mensaje_id: "msg-001", contrato: { ...base, fecha_fin: { valor: "2027-02-30", confianza: 1 } } }],
    ["moneda desconocida", "contratos_validar", { mensaje_id: "msg-001", contrato: { ...base, moneda: { valor: "EUR", confianza: 1 } } }],
    ["fecha de alertas inválida", "contratos_alertas", { hoy: "03/09/2026" }],
    ["registrar dos veces", "contratos_registrar", { mensaje_id: "msg-001", contrato: base }],
    ["sin contrato que extraer", "contratos_extraer", { mensaje_id: "msg-005" }],
  ]
  for (const [nombre, herramienta, args] of casos) {
    const r = await invocar<unknown>(herramienta, args)
    if (r.ok) x(`${nombre}: se esperaba error y la herramienta respondió ok`)
    else ok(`${nombre}: ${r.error}`)
  }

  linea("\n=== 6. CA2: el modelo no puede cambiar un valor sin que el humano lo confirme ===")
  const alterado = { ...base, valor: { valor: 300_000_000, confianza: 1 } }
  const intento = await invocar<ResultadoValidacion>("contratos_validar", { mensaje_id: "msg-001", contrato: alterado })
  if (intento.ok && intento.data.requiere_revision.includes("valor")) {
    ok(`valor alterado a 300.000.000 con confianza 1 -> en revisión: ${intento.data.motivos_revision.valor ?? ""}`)
  } else {
    x(`el valor alterado no se detectó: ${JSON.stringify(intento)}`)
  }

  linea("\nEvidencia en out/: sharepoint/maestro-contratos.csv, sharepoint/historial.jsonl, sharepoint/Contratos/, procesados.json, alertas.md, log.jsonl")
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
