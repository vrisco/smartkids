// Texto con notación, para documentos de estudio y fichas de cualquier materia:
//  - "rich" (documentos): texto plano con **negrita**; las matemáticas, SOLO entre `$...$`; `\$` = dólar.
//  - "math" (ejercicios de matemáticas y ciencias): todo el texto con MathText, como en la sesión.
//  - "plain" (ejercicios de lengua, idiomas, sociales): texto tal cual, con **negrita**.
// MathText sobre prosa estropea el texto: «y/o» sale como fracción y la «I» inglesa en cursiva.
// Los huecos `{{n}}` y los saltos de línea funcionan en los tres modos.
import { Fragment, type ReactNode } from "react";
import { renderMath } from "./MathText";

export type Notation = "rich" | "math" | "plain";

const PLAIN_TOKENS = /(\*\*.+?\*\*|\{\{\d+\}\}|\n)/g;

function plainNodes(s: string, key: string, blank?: (n: number) => ReactNode): ReactNode[] {
  return s
    .split(PLAIN_TOKENS)
    .filter((p) => p !== "")
    .map((p, i) => {
      const k = `${key}-${i}`;
      if (p === "\n") return <br key={k} />;
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <b key={k}>{p.slice(2, -2)}</b>;
      const m = /^\{\{(\d+)\}\}$/.exec(p);
      if (m) return <Fragment key={k}>{blank ? blank(Number(m[1])) : <span className="mblank" />}</Fragment>;
      return <Fragment key={k}>{p}</Fragment>;
    });
}

/** Trocea por `$` sin escapar: los trozos impares son matemáticas. */
function splitDollars(s: string): { math: boolean; s: string }[] {
  const out: { math: boolean; s: string }[] = [];
  let cur = "";
  let math = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "$") {
      cur += "$";
      i++;
    } else if (c === "$") {
      out.push({ math, s: cur });
      cur = "";
      math = !math;
    } else cur += c;
  }
  out.push({ math, s: cur });
  return out.filter((p) => p.s !== "");
}

export function renderTxt(text: string, notation: Notation = "rich", blank?: (n: number) => ReactNode): ReactNode {
  const opts = blank ? { blank } : {};
  if (notation === "math") return renderMath(text, opts);
  if (notation === "plain") return plainNodes(text, "p", blank);
  return splitDollars(text).map((p, i) =>
    p.math ? (
      <span key={i} className="mtx">
        {renderMath(p.s, opts)}
      </span>
    ) : (
      <Fragment key={i}>{plainNodes(p.s, `r${i}`, blank)}</Fragment>
    ),
  );
}

export function Txt({ text, notation = "rich", blank, className }: { text: string; notation?: Notation; blank?: (n: number) => ReactNode; className?: string }) {
  return <span className={className}>{renderTxt(text, notation, blank)}</span>;
}
