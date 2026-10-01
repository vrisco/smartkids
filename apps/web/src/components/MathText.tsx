import { useMemo, type ReactNode } from "react";

/**
 * Render de notación matemática "smart-ASCII" (la que usa el contenido de smartkids).
 * Sin dependencias; el mismo algoritmo se prototipó y validó antes de portarlo.
 *
 * NOTACIÓN SOPORTADA (guía para autores y para el generador de contenido):
 *   - Fracciones apiladas:      a/b, x/2, (x+1)/2        (el operando es un número, una letra o un grupo)
 *   - Exponentes/superíndices:  2^5, x^2, (x+3)^2, 2^(-3), 10^(-3)   ('^' liga con el átomo anterior)
 *   - Raíces con radicando:     √81, √(9 + 16), sqrt(9+16)
 *   - Variables en cursiva:     letras sueltas (salvo conjunciones a/e/o/u/y)
 *   - Signos embellecidos:      '-' → '−',  '*' → '·'
 *   - Huecos {{n}} EN CUALQUIER posición (incluido el exponente, p. ej. 2^{{1}}); el consumidor
 *     decide cómo pintarlos vía `opts.blank` (FillBlanks los sustituye por un <input> ahí mismo).
 * Todo lo demás (texto, +, =, :, paréntesis…) se pinta tal cual.
 */

type MNode =
  | { k: "text"; s: string }
  | { k: "var"; s: string }
  | { k: "grp"; inner: MNode[] }
  | { k: "seq"; nodes: MNode[] }
  | { k: "frac"; num: MNode; den: MNode }
  | { k: "pow"; base: MNode; exp: MNode }
  | { k: "root"; rad: MNode }
  | { k: "blank"; n: number };

type Atom =
  | { t: "blank"; n: number }
  | { t: "group"; inner: string }
  | { t: "root" }
  | { t: "word"; text: string }
  | { t: "pow" }
  | { t: "frac" }
  | { t: "char"; text: string };

const NON_VAR = new Set(["a", "e", "o", "u", "y"]); // conjunciones/preposiciones: NO son variables
const EMPTY: MNode = { k: "text", s: "" };

/** Lee un grupo balanceado a partir del '(' en `i`. Devuelve [contenido, índiceFinal]. */
function readGroup(s: string, i: number): [string, number] {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
  }
  return [s.slice(i + 1, j - 1), j];
}

/** Trocea en átomos: hueco, grupo, raíz, palabra/número, operadores ^ / , o carácter suelto. */
function atomize(s: string): Atom[] {
  const atoms: Atom[] = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("{{", i)) {
      const j = s.indexOf("}}", i);
      if (j >= 0) {
        const n = parseInt(s.slice(i + 2, j), 10);
        atoms.push({ t: "blank", n: Number.isFinite(n) ? n : atoms.filter((a) => a.t === "blank").length + 1 });
        i = j + 2;
        continue;
      }
    }
    const c = s[i]!;
    if (c === "(") {
      const [inner, end] = readGroup(s, i);
      atoms.push({ t: "group", inner });
      i = end;
      continue;
    }
    if (c === "√") {
      atoms.push({ t: "root" });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      atoms.push({ t: "word", text: s.slice(i, j) });
      i = j;
      continue;
    }
    // Cualquier letra (\p{L}), no solo ASCII: si no, «fracción» se partía en «fracci» + «ó» + «n» y la
    // «n» suelta salía en cursiva como si fuera una variable.
    if (/\p{L}/u.test(c)) {
      let j = i;
      while (j < s.length && /\p{L}/u.test(s[j]!)) j++;
      const w = s.slice(i, j);
      if (w === "sqrt") atoms.push({ t: "root" });
      else atoms.push({ t: "word", text: w });
      i = j;
      continue;
    }
    if (c === "^") {
      atoms.push({ t: "pow" });
      i++;
      continue;
    }
    if (c === "/") {
      atoms.push({ t: "frac" });
      i++;
      continue;
    }
    atoms.push({ t: "char", text: c });
    i++;
  }
  return atoms;
}

function atomNode(a: Atom): MNode {
  switch (a.t) {
    case "blank":
      return { k: "blank", n: a.n };
    case "group":
      return { k: "grp", inner: build(a.inner) };
    case "word":
      return a.text.length === 1 && /[A-Za-z]/.test(a.text) && !NON_VAR.has(a.text.toLowerCase())
        ? { k: "var", s: a.text }
        : { k: "text", s: a.text };
    case "char": {
      const ch = a.text === "-" ? "−" : a.text === "*" ? "·" : a.text;
      return { k: "text", s: ch };
    }
    default:
      return EMPTY;
  }
}

/** Operando "desnudo" tomado del átomo SIGUIENTE (exponente/radicando/denominador): un grupo pierde sus paréntesis. */
function bareNode(a: Atom | undefined): MNode {
  if (!a) return EMPTY;
  if (a.t === "group") return { k: "seq", nodes: build(a.inner) };
  return atomNode(a);
}

function build(src: string): MNode[] {
  const atoms = atomize(src);
  const out: MNode[] = [];
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i]!;
    if (a.t === "root") {
      out.push({ k: "root", rad: bareNode(atoms[++i]) });
    } else if (a.t === "pow") {
      const exp = bareNode(atoms[++i]);
      out.push({ k: "pow", base: out.pop() ?? EMPTY, exp });
    } else if (a.t === "frac") {
      const den = bareNode(atoms[++i]);
      out.push({ k: "frac", num: out.pop() ?? EMPTY, den });
    } else {
      out.push(atomNode(a));
    }
  }
  return out;
}

export interface MathOpts {
  /** Cómo pintar un hueco {{n}} (n es el número del hueco). Por defecto, una marca discontinua. */
  blank?: (n: number) => ReactNode;
}

function renderNode(node: MNode, key: string, opts: MathOpts): ReactNode {
  switch (node.k) {
    case "text":
      return node.s;
    case "var":
      return (
        <i className="mvar" key={key}>
          {node.s}
        </i>
      );
    case "grp":
      return <span key={key}>({renderList(node.inner, opts, key + "g")})</span>;
    case "seq":
      return <span key={key}>{renderList(node.nodes, opts, key + "s")}</span>;
    case "frac":
      return (
        <span className="frac" key={key}>
          <span className="num">{renderNode(node.num, key + "n", opts)}</span>
          <span className="den">{renderNode(node.den, key + "d", opts)}</span>
        </span>
      );
    case "pow":
      return (
        <span key={key}>
          {renderNode(node.base, key + "b", opts)}
          <span className="mexp">{renderNode(node.exp, key + "e", opts)}</span>
        </span>
      );
    case "root":
      return (
        <span className="root" key={key}>
          <span className="rad">√</span>
          <span className="radicand">{renderNode(node.rad, key + "r", opts)}</span>
        </span>
      );
    case "blank":
      return <span key={key}>{opts.blank ? opts.blank(node.n) : <span className="mblank" />}</span>;
  }
}

function renderList(nodes: MNode[], opts: MathOpts, prefix = "m"): ReactNode[] {
  return nodes.map((n, i) => renderNode(n, prefix + i, opts));
}

/** Render de una cadena matemática a nodos React. `opts.blank` sustituye los huecos {{n}} (p. ej. por inputs). */
export function renderMath(text: string, opts: MathOpts = {}): ReactNode {
  return renderList(build(text), opts);
}

/** Texto matemático inline (sin huecos interactivos). */
export function MathText({ text, className }: { text: string; className?: string }) {
  const nodes = useMemo(() => build(text), [text]);
  return <span className={className}>{renderList(nodes, {})}</span>;
}
