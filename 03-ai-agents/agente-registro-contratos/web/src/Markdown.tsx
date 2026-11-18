import type { ReactNode } from "react"

/**
 * Render mínimo del Markdown que escribe el agente (tablas por mensaje, listas, negritas).
 * Construye elementos de React, nunca HTML crudo: el texto puede citar correos y contratos
 * de terceros, así que no se usa dangerouslySetInnerHTML ni una librería que lo haga.
 */
export function Markdown({ texto }: { texto: string }) {
  return <div className="markdown">{bloques(texto.replace(/\r\n/g, "\n").split("\n"))}</div>
}

const TABLA = /^\s*\|.*\|\s*$/
const SEPARADOR_TABLA = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const VINETA = /^\s*[-*]\s+(.*)$/
const NUMERADA = /^\s*\d+[.)]\s+(.*)$/
const TITULO = /^(#{1,4})\s+(.*)$/

function bloques(lineas: string[]): ReactNode[] {
  const salida: ReactNode[] = []
  let i = 0
  while (i < lineas.length) {
    const linea = lineas[i] ?? ""

    if (linea.trim() === "") {
      i++
    } else if (linea.trim().startsWith("```")) {
      const codigo: string[] = []
      i++
      while (i < lineas.length && !(lineas[i] ?? "").trim().startsWith("```")) codigo.push(lineas[i++] ?? "")
      i++
      salida.push(<pre key={salida.length}>{codigo.join("\n")}</pre>)
    } else if (TABLA.test(linea) && SEPARADOR_TABLA.test(lineas[i + 1] ?? "")) {
      const filas: string[][] = [celdas(linea)]
      i += 2
      while (i < lineas.length && TABLA.test(lineas[i] ?? "")) filas.push(celdas(lineas[i++] ?? ""))
      salida.push(tabla(filas, salida.length))
    } else if (TITULO.test(linea)) {
      const [, , contenido = ""] = TITULO.exec(linea) ?? []
      salida.push(<p key={salida.length} className="markdown__titulo">{enLinea(contenido)}</p>)
      i++
    } else if (VINETA.test(linea) || NUMERADA.test(linea)) {
      const numerada = NUMERADA.test(linea)
      const patron = numerada ? NUMERADA : VINETA
      const items: ReactNode[] = []
      while (i < lineas.length && patron.test(lineas[i] ?? "")) {
        const [, contenido = ""] = patron.exec(lineas[i] ?? "") ?? []
        items.push(<li key={items.length}>{enLinea(contenido)}</li>)
        i++
      }
      salida.push(numerada ? <ol key={salida.length}>{items}</ol> : <ul key={salida.length}>{items}</ul>)
    } else {
      const parrafo: string[] = []
      while (i < lineas.length && (lineas[i] ?? "").trim() !== "" && !inicioDeBloque(lineas, i)) parrafo.push(lineas[i++] ?? "")
      salida.push(<p key={salida.length}>{enLinea(parrafo.join("\n"))}</p>)
    }
  }
  return salida
}

function inicioDeBloque(lineas: string[], i: number): boolean {
  const linea = lineas[i] ?? ""
  return (
    linea.trim().startsWith("```") ||
    TITULO.test(linea) ||
    VINETA.test(linea) ||
    NUMERADA.test(linea) ||
    (TABLA.test(linea) && SEPARADOR_TABLA.test(lineas[i + 1] ?? ""))
  )
}

function celdas(linea: string): string[] {
  return linea.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

function tabla(filas: string[][], clave: number): ReactNode {
  const [encabezado = [], ...cuerpo] = filas
  return (
    <div key={clave} className="markdown__tabla">
      <table>
        <thead>
          <tr>{encabezado.map((c, j) => <th key={j}>{enLinea(c)}</th>)}</tr>
        </thead>
        <tbody>
          {cuerpo.map((fila, k) => (
            <tr key={k}>{fila.map((c, j) => <td key={j}>{enLinea(c)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Negrita (**x**) y código (`x`); todo lo demás queda como texto plano escapado por React. */
function enLinea(texto: string): ReactNode[] {
  return texto.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((parte, i) => {
    if (parte.startsWith("**") && parte.endsWith("**") && parte.length > 4) return <strong key={i}>{parte.slice(2, -2)}</strong>
    if (parte.startsWith("`") && parte.endsWith("`") && parte.length > 2) return <code key={i}>{parte.slice(1, -1)}</code>
    return parte
  })
}
