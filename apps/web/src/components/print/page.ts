// Reglas @page de un trabajo de impresión. Puro (sin React) para poder probar el escapado del título.

export type PaperSize = "A4" | "letter";

export interface PrintOptions {
  /** Nombre del PDF (el navegador usa el título de la pestaña). */
  fileName: string;
  paper?: PaperSize;
  landscape?: boolean;
  /** Número de página «3 / 5» al pie (Chrome y Edge; el resto lo ignora). */
  pageNumbers?: boolean;
  /** Texto pequeño arriba a la derecha de cada página. */
  headerText?: string;
}

/** Cadena CSS segura: cualquier carácter que no sea letra, número o espacio va escapado (`\hex `). Un
 *  título con comillas, llaves o barras no puede cerrar la cadena e inyectar reglas. */
export function cssString(s: string): string {
  return '"' + [...s].map((ch) => (/[\p{L}\p{N} ]/u.test(ch) ? ch : `\\${ch.codePointAt(0)!.toString(16)} `)).join("") + '"';
}

export const safeFileName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "smartkids";

/** Tamaño, orientación, márgenes y cajas de margen (número de página y título). */
export function pageCss(o: PrintOptions): string {
  const size = `${o.paper === "letter" ? "letter" : "A4"}${o.landscape ? " landscape" : ""}`;
  const boxes = [
    o.pageNumbers === false ? "" : `@bottom-center { content: counter(page) " / " counter(pages); font-size: 8.5pt; font-family: system-ui, sans-serif; color: var(--print-dim); }`,
    o.headerText ? `@top-right { content: ${cssString(o.headerText.slice(0, 80))}; font-size: 8pt; font-family: system-ui, sans-serif; color: var(--print-dim); }` : "",
  ].join(" ");
  return `@page { size: ${size}; margin: 13mm 12mm 14mm; ${boxes} }`;
}
