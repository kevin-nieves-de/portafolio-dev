import { promises as fs } from "node:fs"
import type { EntradaHistorial, FilaMaestro } from "./esquemas.js"
import { diasEntre } from "./fechas.js"
import { leerMaestro } from "./maestro.js"
import { alertasPath, escribirTexto, existeArchivo, historialPath, rutaRelativa } from "./rutas.js"

/** Fecha en que se congeló el maestro (PRD §1). Lo registrado desde aquí es el gap que el agente cubre. */
export const FECHA_CORTE_MAESTRO = "2026-05-30"
/** HU-5 / O4: horizonte de alerta de vencimiento. */
export const DIAS_ALERTA_VENCIMIENTO = 60

export interface ContratoPorVencer {
  id_contrato: string
  cliente: string
  fecha_fin: string
  dias_restantes: number
  estado_poliza: FilaMaestro["estado_poliza"]
}

export interface PolizaPendiente {
  id_contrato: string
  cliente: string
  tipo_poliza: string
  estado_poliza: FilaMaestro["estado_poliza"]
  fecha_fin: string
}

export interface RegistroDesdeCorte {
  id_contrato: string
  cliente: string
  accion: "insercion" | "actualizacion"
  fecha: string
}

export interface ReporteAlertas {
  ruta: string
  hoy: string
  vencen: ContratoPorVencer[]
  polizas_pendientes: PolizaPendiente[]
  registrados_desde_corte: RegistroDesdeCorte[]
  /** Contexto adicional: ya vencidos sin acta de terminación ni prórroga registrada. */
  vencidos: ContratoPorVencer[]
}

export async function generarAlertas(directory: string, hoy: string): Promise<ReporteAlertas> {
  const filas = await leerMaestro(directory)
  const historial = await leerHistorial(directory)

  const conDias = filas.map((f) => ({ fila: f, dias: diasEntre(hoy, f.fecha_fin) }))
  const aVencimiento = ({ fila, dias }: { fila: FilaMaestro; dias: number }): ContratoPorVencer => ({
    id_contrato: fila.id_contrato,
    cliente: fila.cliente,
    fecha_fin: fila.fecha_fin,
    dias_restantes: dias,
    estado_poliza: fila.estado_poliza,
  })

  const reporte: Omit<ReporteAlertas, "ruta"> = {
    hoy,
    vencen: conDias
      .filter(({ dias }) => dias >= 0 && dias <= DIAS_ALERTA_VENCIMIENTO)
      .sort((a, b) => a.dias - b.dias)
      .map(aVencimiento),
    polizas_pendientes: filas
      .filter((f) => f.requiere_poliza && f.estado_poliza !== "vigente")
      .map((f) => ({
        id_contrato: f.id_contrato,
        cliente: f.cliente,
        tipo_poliza: f.tipo_poliza,
        estado_poliza: f.estado_poliza,
        fecha_fin: f.fecha_fin,
      })),
    registrados_desde_corte: registrosDesdeCorte(filas, historial),
    vencidos: conDias
      .filter(({ dias }) => dias < 0)
      .sort((a, b) => a.dias - b.dias)
      .map(aVencimiento),
  }

  const ruta = alertasPath(directory)
  await escribirTexto(ruta, renderizarMarkdown(reporte))
  return { ruta: rutaRelativa(directory, ruta), ...reporte }
}

/**
 * Inserciones (por `fecha_registro`) y actualizaciones (por la `fecha_recepcion` del historial)
 * desde el corte del maestro. Se usa la fecha de recepción y no `ts` para que el reporte dependa
 * del buzón y no del reloj de la máquina.
 */
function registrosDesdeCorte(filas: FilaMaestro[], historial: EntradaHistorial[]): RegistroDesdeCorte[] {
  const insertados: RegistroDesdeCorte[] = filas
    .filter((f) => f.fecha_registro >= FECHA_CORTE_MAESTRO)
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, accion: "insercion", fecha: f.fecha_registro }))
  const yaListados = new Set(insertados.map((r) => r.id_contrato))

  const actualizados: RegistroDesdeCorte[] = []
  for (const entrada of historial) {
    const fecha = entrada.fecha_recepcion
    if (entrada.accion !== "actualizacion" || fecha < FECHA_CORTE_MAESTRO || yaListados.has(entrada.id_contrato)) continue
    const fila = filas.find((f) => f.id_contrato === entrada.id_contrato)
    actualizados.push({ id_contrato: entrada.id_contrato, cliente: fila?.cliente ?? "", accion: "actualizacion", fecha })
    yaListados.add(entrada.id_contrato)
  }
  return [...insertados, ...actualizados]
}

async function leerHistorial(directory: string): Promise<EntradaHistorial[]> {
  const ruta = historialPath(directory)
  if (!(await existeArchivo(ruta))) return []
  const lineas = (await fs.readFile(ruta, "utf-8")).split("\n").filter(Boolean)
  return lineas.map((linea, i) => {
    try {
      return JSON.parse(linea) as EntradaHistorial
    } catch {
      throw new Error(`historial.jsonl tiene una línea corrupta (${i + 1})`)
    }
  })
}

/** Un "|" o un salto de línea en una razón social rompería la tabla Markdown. */
function escaparCelda(texto: string): string {
  return texto.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")
}

function renderizarMarkdown(r: Omit<ReporteAlertas, "ruta">): string {
  const tabla = (encabezados: string[], filas: string[][]): string =>
    filas.length === 0
      ? "_Sin registros._\n"
      : [`| ${encabezados.join(" | ")} |`, `|${encabezados.map(() => "---").join("|")}|`, ...filas.map((f) => `| ${f.map(escaparCelda).join(" | ")} |`)].join("\n") + "\n"

  return [
    `# Alertas de contratos — ${r.hoy}`,
    "",
    `## 1. Vencen en ${DIAS_ALERTA_VENCIMIENTO} días o menos`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha fin", "Días", "Póliza"],
      r.vencen.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias_restantes), c.estado_poliza]),
    ),
    "## 2. Pólizas exigidas que no están vigentes",
    "",
    tabla(
      ["Contrato", "Cliente", "Tipo de póliza", "Estado", "Fecha fin contrato"],
      r.polizas_pendientes.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza.split(";").join(", "), p.estado_poliza, p.fecha_fin]),
    ),
    `## 3. Registrados desde el corte del maestro (${FECHA_CORTE_MAESTRO})`,
    "",
    tabla(
      ["Contrato", "Cliente", "Acción", "Fecha"],
      r.registrados_desde_corte.map((x) => [x.id_contrato, x.cliente, x.accion, x.fecha]),
    ),
    "## Contexto: contratos ya vencidos",
    "",
    "Siguen en el maestro sin acta de terminación ni prórroga registrada.",
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha fin", "Días vencido"],
      r.vencidos.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(-c.dias_restantes)]),
    ),
  ].join("\n")
}
