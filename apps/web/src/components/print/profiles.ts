// Perfiles de impresión: cómo se ve el papel según la MATERIA y la EDAD. Puro (sin React ni i18n) para
// poder probarlo con el runner de Node: la materia decide el tipo de espacio de trabajo (cuadrícula en
// matemáticas, renglones en lengua...) y la edad, el tamaño de letra, de la cuadrícula y de la pauta.
import { subjectFamily, type SubjectFamily } from "@smartkids/shared/catalog";
import type { Exercise as FullExercise } from "@smartkids/shared";

export type { SubjectFamily };
/** Tramos de edad: PRI-1/2 · PRI-3/4 · PRI-5/6 · ESO y Bachillerato (sin curso = como 5.º-6.º). */
export type AgeBand = "early" | "mid" | "upper" | "secondary";
/** Renglón: simple, doble pauta (cursiva con línea central) o pauta Montessori (4 guías). */
export type LineStyle = "single" | "double" | "montessori";

export interface PrintProfile {
  family: SubjectFamily;
  age: AgeBand;
  /** Notación matemática (fracciones apiladas, potencias...) en los enunciados. En lengua o idiomas no:
   *  MathText pondría en cursiva la «I» inglesa y convertiría «y/o» en una fracción. */
  mathNotation: boolean;
  fontPt: number;
  /** Lado del cuadrito de la cuadrícula de trabajo. */
  gridMm: number;
  /** Casilla de las cuentas en columna. */
  opCellMm: number;
  line: LineStyle;
  /** Altura de cada renglón. */
  lineMm: number;
  /** Instrucciones con el tono para los más pequeños. */
  kidTone: boolean;
  figureMaxMm: [number, number];
}

export function ageBand(gradeBand?: string | null): AgeBand {
  const pri = /^PRI-(\d)$/.exec(gradeBand ?? "");
  if (pri) {
    const n = Number(pri[1]);
    return n <= 2 ? "early" : n <= 4 ? "mid" : "upper";
  }
  // Solo cursos reales (ESO-1..4, BACH-1..2): el antiguo «ESO-5» significa «sin definir».
  return /^(ESO-[1-4]|BACH-[12])$/.test(gradeBand ?? "") ? "secondary" : "upper";
}

const BY_AGE: Record<AgeBand, Pick<PrintProfile, "fontPt" | "gridMm" | "opCellMm" | "line" | "lineMm">> = {
  early: { fontPt: 14, gridMm: 8, opCellMm: 9, line: "montessori", lineMm: 15 },
  mid: { fontPt: 13, gridMm: 6, opCellMm: 8, line: "double", lineMm: 10 },
  upper: { fontPt: 12, gridMm: 5, opCellMm: 7, line: "single", lineMm: 8 },
  secondary: { fontPt: 11.5, gridMm: 5, opCellMm: 6.5, line: "single", lineMm: 7 },
};

/** Perfil de una materia (id libre: «math», «lengua», «Historia»... o la clave de un preset) y un curso. */
export function profileFor(subject: string | null | undefined, gradeBand: string | null | undefined): PrintProfile {
  const family = subjectFamily(subject);
  const age = ageBand(gradeBand);
  const visual = family === "science" || family === "social";
  return {
    family,
    age,
    mathNotation: family === "math" || family === "science" || family === "generic",
    kidTone: age === "early",
    figureMaxMm: visual ? [100, 75] : [75, 55],
    ...BY_AGE[age],
  };
}

/** Escala de letra elegida en el diálogo («auto» = la del perfil). */
export type FontChoice = "auto" | "normal" | "large" | "xlarge";
export function fontPtFor(p: PrintProfile, choice: FontChoice): number {
  return choice === "auto" ? p.fontPt : choice === "normal" ? 12 : choice === "large" ? 14 : 16;
}

/* ---------- Espacio de trabajo por tipo de ejercicio ---------- */

export type WorkSpec =
  | { kind: "grid"; heightMm: number }
  | { kind: "problem"; heightMm: number }
  | { kind: "lines"; lines: number };

const LEVEL_IDX = { easy: 0, medium: 1, hard: 2 } as const;
/** Ningún espacio supera esto: `break-inside: avoid` deja de funcionar si la pregunta no cabe en una página. */
const MAX_WORK_MM = 120;

function scaled(mm: number, p: PrintProfile, compact: boolean): number {
  const f = (p.age === "early" ? 1.3 : 1) * (compact ? 0.6 : 1);
  return Math.min(MAX_WORK_MM, Math.round(mm * f));
}

/**
 * Espacio para hacer el ejercicio en el papel (además de donde va la respuesta). Matemáticas: cuadrícula,
 * más alta cuanto más difícil; problemas con «Datos / Operaciones / Solución». Ciencias: cuadrícula más
 * corta. El resto de materias responde en renglones (ver answerStyle), sin cuadrícula.
 */
export function workFor(ex: FullExercise, p: PrintProfile, o: { workSpace: boolean; compact: boolean }): WorkSpec | null {
  if (!o.workSpace) return null;
  const lv = LEVEL_IDX[ex.difficulty.level];
  const numeric = p.family === "math" || p.family === "generic";
  switch (ex.type) {
    case "numeric":
      if (numeric) return { kind: "grid", heightMm: scaled([20, 30, 45][lv]!, p, o.compact) };
      if (p.family === "science") return { kind: "grid", heightMm: scaled([20, 25, 35][lv]!, p, o.compact) };
      return null;
    case "step_problem":
      if (numeric) return { kind: "problem", heightMm: scaled(Math.min(90, 35 + 10 * ex.steps.length), p, o.compact) };
      if (p.family === "science") return { kind: "grid", heightMm: scaled(30 + 8 * ex.steps.length, p, o.compact) };
      return null;
    case "multiple_choice":
    case "multiple_select":
    case "true_false":
      // Una pregunta de cálculo con opciones también se opera: un poco de cuadrícula.
      if (numeric && lv > 0 && /\d/.test(ex.stem)) return { kind: "grid", heightMm: scaled(15, p, o.compact) };
      return null;
    default:
      return null;
  }
}

/**
 * Dónde escribe la RESPUESTA una pregunta abierta: recuadro (resultado numérico), una línea o varios
 * renglones (respuestas largas o de lengua).
 */
export function answerStyle(ex: FullExercise, p: PrintProfile): { kind: "box" | "line" } | { kind: "lines"; lines: number } {
  const numeric = p.family === "math" || p.family === "generic" || p.family === "science";
  if (ex.type === "numeric") return { kind: numeric ? "box" : "line" };
  if (ex.type === "fill_in_blank") {
    const longest = Math.max(...ex.blanks.map((b) => Math.max(...b.accept.map((a) => a.length))));
    if (numeric && longest <= 12) return { kind: "box" };
    if (longest > 25 || p.family === "social") return { kind: "lines", lines: longest > 60 ? 3 : 2 };
    return { kind: "line" };
  }
  return { kind: "line" };
}

/** Ancho de un hueco en mm. Por tramos y no exacto: el papel no debe chivar cuántas letras lleva. */
export function blankWidthMm(accept: string[]): number {
  const n = Math.max(0, ...accept.map((a) => a.length));
  return n <= 4 ? 22 : n <= 12 ? 35 : 55;
}
