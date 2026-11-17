import { normalizar } from "./normalizar.js"

const MESES: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
}
const PATRON_MES = Object.keys(MESES).join("|")

/** Valida y arma una fecha ISO. Lanza con mensaje legible si no existe (31 de junio, 30 de febrero). */
export function fechaIso(anio: number, mes: number, dia: number): string {
  const fecha = new Date(Date.UTC(anio, mes - 1, dia))
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
    throw new Error(`fecha inválida: ${dia}/${mes}/${anio}`)
  }
  return fecha.toISOString().slice(0, 10)
}

export function esFechaIsoValida(texto: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto)
  if (!m) return false
  try {
    fechaIso(Number(m[1]), Number(m[2]), Number(m[3]))
    return true
  } catch {
    return false
  }
}

export interface FechaEncontrada {
  iso: string
  /** Posición en el texto normalizado: sirve para ordenar ("desde X hasta Y"), no para recortar el original. */
  indice: number
}

/**
 * Encuentra fechas escritas como en los contratos: "primero (1) de agosto de 2026",
 * "treinta y uno (31) de julio de 2027", "27 de agosto de 2026", "a los treinta (30) días del mes
 * de julio de 2026". Se usa el dígito, nunca el número en letras: el dígito entre paréntesis es
 * la cifra que vale legalmente.
 * Las fechas imposibles (31 de junio) lanzan error en vez de descartarse en silencio.
 */
export function buscarFechas(texto: string): FechaEncontrada[] {
  const patron = new RegExp(`\\(?(\\d{1,2})\\)?\\s+(?:dias\\s+del\\s+mes\\s+)?de\\s+(${PATRON_MES})\\s+(?:de|del)\\s+(\\d{4})`, "g")
  const normalizado = normalizar(texto)
  const encontradas: FechaEncontrada[] = []
  for (const m of normalizado.matchAll(patron)) {
    const mes = MESES[m[2] ?? ""]
    if (mes === undefined) continue
    encontradas.push({ iso: fechaIso(Number(m[3]), mes, Number(m[1])), indice: m.index })
  }
  return encontradas
}

/**
 * "en el mes de agosto de 2026" (sin día) -> { anio: 2026, mes: 8 }. Es una fecha incompleta, no
 * una fecha. Excluye "(30) días del mes de julio", que sí trae día y lo resuelve `buscarFechas`.
 */
export function buscarMesSinDia(texto: string): { anio: number; mes: number } | null {
  const patron = new RegExp(`(?<!dias del )mes\\s+de\\s+(${PATRON_MES})\\s+(?:de|del)\\s+(\\d{4})`)
  const m = patron.exec(normalizar(texto))
  const mes = MESES[m?.[1] ?? ""]
  if (!m || mes === undefined) return null
  return { anio: Number(m[2]), mes }
}

/** "doce (12) meses" o "12 meses" -> 12. Toma el dígito, no el número en letras. */
export function buscarPlazoEnMeses(texto: string): number | null {
  const m = /\(?(\d{1,3})\)?\s+mes(?:es)?\b/.exec(normalizar(texto))
  return m ? Number(m[1]) : null
}

/**
 * Fin de un plazo en meses, con la convención de los contratos del maestro: el último día
 * es el anterior al aniversario (2026-05-15 + 6 meses -> 2026-11-14; 2025-07-01 + 12 -> 2026-06-30).
 * Si el día no existe en el mes destino, se toma el último del mes (2026-01-31 + 1 -> 2026-02-27).
 */
export function finDePlazo(inicioIso: string, meses: number): string {
  const [anio, mes, dia] = inicioIso.split("-").map(Number) as [number, number, number]
  const mesDestino = mes - 1 + meses
  const ultimoDiaDestino = new Date(Date.UTC(anio, mesDestino + 1, 0)).getUTCDate()
  const aniversario = new Date(Date.UTC(anio, mesDestino, Math.min(dia, ultimoDiaDestino)))
  aniversario.setUTCDate(aniversario.getUTCDate() - 1)
  return aniversario.toISOString().slice(0, 10)
}

/** Días calendario de `desdeIso` a `hastaIso`. Negativo si `hasta` ya pasó. */
export function diasEntre(desdeIso: string, hastaIso: string): number {
  const MS_DIA = 86_400_000
  return Math.round((Date.parse(hastaIso) - Date.parse(desdeIso)) / MS_DIA)
}
