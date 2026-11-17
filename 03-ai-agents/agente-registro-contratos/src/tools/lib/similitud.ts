import { normalizar } from "./normalizar.js"

/**
 * Coeficiente de Sørensen-Dice sobre bigramas de caracteres, en [0, 1].
 * RN2 usa ≥ 0.9 entre objetos del mismo `nit_cliente` para detectar una actualización sin id.
 * Se eligió sobre igualdad exacta porque el mismo objeto se redacta con variaciones menores
 * ("mesa de servicio TI nivel 1 y 2" vs "mesa de servicio de TI niveles 1 y 2"), y sobre
 * Jaccard de palabras porque tolera plurales y tildes sin un stemmer.
 */
export function similitudTexto(a: string, b: string): number {
  const na = normalizar(a).replace(/[^a-z0-9 ]/g, "")
  const nb = normalizar(b).replace(/[^a-z0-9 ]/g, "")
  if (na === nb) return 1
  if (na.length < 2 || nb.length < 2) return 0

  const bigramasA = contarBigramas(na)
  const bigramasB = contarBigramas(nb)
  let interseccion = 0
  for (const [bigrama, cuentaA] of bigramasA) {
    interseccion += Math.min(cuentaA, bigramasB.get(bigrama) ?? 0)
  }
  return (2 * interseccion) / (na.length - 1 + (nb.length - 1))
}

function contarBigramas(texto: string): Map<string, number> {
  const cuentas = new Map<string, number>()
  for (let i = 0; i < texto.length - 1; i++) {
    const bigrama = texto.slice(i, i + 2)
    cuentas.set(bigrama, (cuentas.get(bigrama) ?? 0) + 1)
  }
  return cuentas
}
