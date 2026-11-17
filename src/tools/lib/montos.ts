import { normalizar } from "./normalizar.js"

export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export type Moneda = (typeof MONEDAS)[number]

export function esMonedaSoportada(codigo: string): codigo is Moneda {
  return (MONEDAS as readonly string[]).includes(codigo)
}

/** Nombre de la moneda en letras, tal como aparece en el texto, para cruzar con el código ISO. */
const PALABRA_A_MONEDA: Array<[RegExp, Moneda]> = [
  [/\bpesos\b/, "COP"],
  [/\bdolares\b/, "USD"],
  [/\bsoles\b/, "PEN"],
  [/\bbalboas\b/, "PAB"],
  [/\blempiras\b/, "HNL"],
]

export function monedaPorPalabra(texto: string): Moneda | null {
  const normalizado = normalizar(texto)
  for (const [patron, moneda] of PALABRA_A_MONEDA) {
    if (patron.test(normalizado)) return moneda
  }
  return null
}

/**
 * Convierte una cifra con separadores al número que representa. Los contratos mezclan
 * convenciones: COP usa punto de miles ("265.000.000"), USD/PEN usan coma de miles y punto
 * decimal ("120,000.00"). Regla: si aparecen ambos separadores, el último es el decimal; si
 * solo hay uno, es de miles cuando se repite o cuando lo siguen exactamente 3 dígitos.
 */
export function parsearCifra(cifra: string): number {
  const limpia = cifra.trim()
  if (!/^\d[\d.,]*$/.test(limpia)) throw new Error(`cifra inválida: "${cifra}"`)

  const ultimoPunto = limpia.lastIndexOf(".")
  const ultimaComa = limpia.lastIndexOf(",")
  let decimal: "." | "," | null = null
  if (ultimoPunto >= 0 && ultimaComa >= 0) {
    decimal = ultimoPunto > ultimaComa ? "." : ","
  } else if (ultimoPunto >= 0 || ultimaComa >= 0) {
    const sep = ultimoPunto >= 0 ? "." : ","
    const veces = limpia.split(sep).length - 1
    const digitosDespues = limpia.length - limpia.lastIndexOf(sep) - 1
    if (veces === 1 && digitosDespues !== 3) decimal = sep
  }

  const miles = decimal === "," ? "." : decimal === "." ? "," : null
  let normalizada = limpia
  if (miles) normalizada = normalizada.split(miles).join("")
  if (decimal === ",") normalizada = normalizada.replace(",", ".")
  if (decimal === null) normalizada = normalizada.replace(/[.,]/g, "")

  const valor = Number(normalizada)
  if (!Number.isFinite(valor)) throw new Error(`cifra inválida: "${cifra}"`)
  return valor
}

/** Etiquetas de identificación que, seguidas de dígitos, parecen un monto ("NIT 890…") y no lo son. */
const NO_SON_MONEDA = new Set(["NIT", "RUC", "RTN", "IVA", "COT"])

export interface MontoEncontrado {
  /** Código tal como aparece. Puede no estar soportado: quien llama decide (HU-6: moneda desconocida). */
  codigo: string
  valor: number
  indice: number
}

/** Busca montos con código de moneda: "COP $265.000.000", "USD 120,000.00", "(PEN 520,000.00)". */
export function buscarMontos(texto: string): MontoEncontrado[] {
  const patron = /\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*\d|\d)/g
  const encontrados: MontoEncontrado[] = []
  for (const m of texto.matchAll(patron)) {
    const codigo = m[1] ?? ""
    if (NO_SON_MONEDA.has(codigo)) continue
    encontrados.push({ codigo, valor: parsearCifra(m[2] ?? ""), indice: m.index })
  }
  return encontrados
}
