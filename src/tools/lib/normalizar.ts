const MARCAS_DIACRITICAS = new RegExp("[\\u0300-\\u036f]", "g")

/** Minúsculas, sin acentos, espacios colapsados. Base de toda comparación de texto. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(MARCAS_DIACRITICAS, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
}

/**
 * Sufijos societarios que no forman parte del slug de carpeta. El maestro archiva
 * "Logística del Istmo S.A." en `logistica-del-istmo/` y "Agroexport Sula S. de R.L." en `agroexport-sula/`.
 * El orden importa: primero los más largos para que "s.a.s." no quede como "s.a." + "s.".
 */
const SUFIJO_SOCIETARIO =
  /[\s,]+(s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?\s?c\.?|s\.?\s?a\.?\s?de\s?c\.?\s?v\.?|s\.?\s?de\s?r\.?\s?l\.?|s\.?\s?r\.?\s?l\.?|s\.?\s?a\.?|ltda\.?|e\.?\s?u\.?)$/

/** Razón social -> nombre de carpeta: `Industrias Delta S.A.S.` -> `industrias-delta`. */
export function slugCliente(razonSocial: string): string {
  const sinSufijo = normalizar(razonSocial).replace(SUFIJO_SOCIETARIO, "")
  return sinSufijo.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/** Recorta a `max` caracteres sin partir una palabra; agrega "…" solo si recortó. */
export function truncar(texto: string, max: number): string {
  const limpio = texto.trim().replace(/\s+/g, " ")
  if (limpio.length <= max) return limpio
  const corte = limpio.slice(0, max - 1)
  const ultimoEspacio = corte.lastIndexOf(" ")
  return (ultimoEspacio > max / 2 ? corte.slice(0, ultimoEspacio) : corte).replace(/[\s,.;:]+$/, "") + "…"
}

/** "INDUSTRIAS DELTA S.A.S." -> "Industrias Delta S.A.S.": capitaliza palabras, respeta siglas con puntos y conectores. */
export function capitalizarRazonSocial(texto: string): string {
  const CONECTORES = new Set(["de", "del", "la", "las", "los", "el", "y", "e"])
  return texto
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((palabra, i) => {
      if (palabra.includes(".")) return palabra.toUpperCase()
      if (i > 0 && CONECTORES.has(palabra)) return palabra
      return palabra.charAt(0).toUpperCase() + palabra.slice(1)
    })
    .join(" ")
}
