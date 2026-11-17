/**
 * CSV mínimo según RFC 4180: campos entre comillas con comas, saltos de línea y comillas dobladas.
 * Hecho a mano en vez de agregar una dependencia porque el maestro tiene un solo formato fijo
 * y el `objeto` de un contrato puede traer comas ("implementación, parametrización y soporte").
 */

export function parsearCsv(contenido: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let entreComillas = false
  const texto = contenido.replace(/^﻿/, "")

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (entreComillas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"'
        i++
      } else if (c === '"') {
        entreComillas = false
      } else {
        campo += c
      }
    } else if (c === '"') {
      entreComillas = true
    } else if (c === ",") {
      fila.push(campo)
      campo = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++
      fila.push(campo)
      filas.push(fila)
      fila = []
      campo = ""
    } else {
      campo += c
    }
  }
  if (entreComillas) throw new Error("CSV mal formado: comillas sin cerrar")
  if (campo !== "" || fila.length > 0) {
    fila.push(campo)
    filas.push(fila)
  }
  return filas.filter((f) => !(f.length === 1 && f[0] === ""))
}

function escaparCampo(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export function serializarCsv(filas: string[][]): string {
  return filas.map((f) => f.map(escaparCampo).join(",")).join("\n") + "\n"
}
