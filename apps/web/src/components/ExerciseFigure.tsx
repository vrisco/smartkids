// Ilustración del ejercicio: SVG en línea, SANEADO y renderizado inline para que
// herede el color del tema (currentColor) y se integre en claro/oscuro. El saneado
// (allowlist de elementos y atributos, fuera <script>/on*/refs externas) evita XSS
// aun cuando el contenido es generado.
import { useMemo } from "react";

// Elementos SVG permitidos (formas, texto, gradientes, marcadores). NADA de
// script/foreignObject/image/use/a que pueda cargar o ejecutar algo externo.
const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "marker",
  "title",
  "desc",
]);

// Atributos permitidos (geometría + presentación). Se excluye cualquier href,
// evento on*, o style (podría colar url()). El color va por currentColor.
const ALLOWED_ATTRS = new Set([
  "viewbox",
  "xmlns",
  "preserveaspectratio",
  "width",
  "height",
  "d",
  "points",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "transform",
  "gradienttransform",
  "gradientunits",
  "offset",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "stop-color",
  "stop-opacity",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "marker-end",
  "marker-start",
  "class",
]);

function sanitizeSvg(input: string): string | null {
  const s = input.trim();
  if (!s.startsWith("<svg")) return null;
  if (typeof window === "undefined" || typeof DOMParser === "undefined") return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(s, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;

  const walk = (el: Element) => {
    // Recorre en copia: vamos a eliminar hijos no permitidos.
    for (const child of Array.from(el.children)) {
      if (!ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (!ALLOWED_ATTRS.has(name) || name.startsWith("on") || name.includes("href")) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  // Limpia atributos del propio <svg> y baja por el árbol.
  for (const attr of Array.from(root.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_ATTRS.has(name) || name.startsWith("on") || name.includes("href")) {
      root.removeAttribute(attr.name);
    }
  }
  walk(root);
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  try {
    return new XMLSerializer().serializeToString(root);
  } catch {
    return null;
  }
}

export function ExerciseFigure({ svg, className }: { svg?: string | null; className?: string }) {
  const clean = useMemo(() => (svg ? sanitizeSvg(svg) : null), [svg]);
  if (!clean) return null;
  return <div className={"ex-figure" + (className ? " " + className : "")} dangerouslySetInnerHTML={{ __html: clean }} />;
}
