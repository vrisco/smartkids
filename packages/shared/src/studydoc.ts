import { z } from "zod";
import { columnSpecProblem } from "./arith.ts";
import { STUDY_DOC_KINDS, type StudyDocKind } from "./catalog.ts";
import { FigureSchema } from "./exercise.ts";
import type { Verdict } from "./grading.ts";

/**
 * Documento de estudio («Apuntes»): resumen, hoja de trucos, tarjetas, glosario, ejemplos resueltos, esquema,
 * línea del tiempo, comprensión lectora, dictado o redacción. Fuente ÚNICA de verdad, como el ejercicio:
 * lo valida la API al importarlo, lo valida el builder de cursos fijos (Vía C) y lo pinta la web, en pantalla
 * Y en papel, a partir del MISMO JSON. Es una lista de BLOQUES tipados, no Markdown ni HTML: así cada bloque
 * sabe pintarse en los dos medios y las respuestas van estructuradas (para la clave del final del PDF).
 *
 * Notación del texto (campos «ricos»): `**negrita**`, `$...$` para matemáticas (fórmulas, fracciones `3/4`,
 * potencias `2^3`; se pintan con MathText) y `\$` para un dólar literal. El resto es texto plano: así el
 * «y/o» de Lengua no se convierte en una fracción ni el «I» de inglés en una variable en cursiva.
 */

export const STUDY_DOC_LIMITS = {
  /** Tope del documento serializado (UTF-8). D1 admite filas mayores, pero el SQL de la Vía C va en sentencias de < 100 KB. */
  maxBytes: 90_000,
  maxBlocks: 150,
  maxText: 4000,
  maxPassage: 12_000,
  maxTitle: 140,
  maxSvgBytes: 20_000,
  maxFigures: 12,
  maxTreeDepth: 4,
  maxTreeNodes: 80,
  maxTableCols: 6,
  maxTableRows: 40,
  maxListItems: 30,
  maxCards: 120,
  maxQuestions: 40,
  maxEvents: 40,
  maxEntries: 120,
  /** Tope del cuerpo de la petición de import (caracteres), antes de parsear. */
  importMaxChars: 250_000,
} as const;
const L = STUDY_DOC_LIMITS;

/* ---------- Primitivas ---------- */

const Rich = z.string().trim().min(1).max(L.maxText);
const Short = z.string().trim().min(1).max(300);
const Lang = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "idioma no válido (es, en, fr, en-GB...)");
const QId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "id de pregunta no válido");

/** Cuenta «como en el cuaderno» de un ejemplo resuelto: la app la coloca y la resuelve (arith.ts). */
export const DocOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("column_operation"),
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    operands: z.array(z.number().nonnegative()).min(2).max(4),
    decimals: z.number().int().min(0).max(3).optional(),
  }),
  z.object({ type: z.literal("prime_factorization"), number: z.number().int().min(2).max(9_999_999) }),
]);
export type DocOperation = z.infer<typeof DocOperationSchema>;

/* ---------- Bloques ---------- */

const HeadingBlock = z.object({ type: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: Short });
const ParagraphBlock = z.object({ type: z.literal("paragraph"), text: Rich });
/** «Recuerda» (remember), «Truco» (tip), «Error típico» (warning) o «¿Sabías que...?» (fact). */
const CalloutBlock = z.object({
  type: z.literal("callout"),
  variant: z.enum(["remember", "tip", "warning", "fact"]),
  title: Short.optional(),
  text: Rich.optional(),
  items: z.array(Rich).min(1).max(L.maxListItems).optional(),
});
const ListItem = z.union([Rich, z.object({ text: Rich, items: z.array(Rich).min(1).max(L.maxListItems) })]);
const ListBlock = z.object({ type: z.literal("list"), ordered: z.boolean().default(false), items: z.array(ListItem).min(1).max(L.maxListItems) });
/** Las celdas pueden ir vacías (tablas para completar en papel). */
const TableBlock = z.object({
  type: z.literal("table"),
  caption: Short.optional(),
  header: z.array(Short).min(1).max(L.maxTableCols),
  rows: z.array(z.array(z.string().trim().max(L.maxText))).min(1).max(L.maxTableRows),
  /** La primera columna hace de cabecera de fila (conjugaciones, comparativas). */
  headerColumn: z.boolean().optional(),
});
/** `expr` va SIEMPRE en notación matemática (sin `$`). */
const FormulaBlock = z.object({
  type: z.literal("formula"),
  expr: z.string().trim().min(1).max(400),
  label: Short.optional(),
  vars: z.array(z.object({ symbol: z.string().trim().min(1).max(40), meaning: Short })).min(1).max(12).optional(),
  note: Rich.optional(),
});
const DefinitionsBlock = z.object({
  type: z.literal("definitions"),
  title: Short.optional(),
  items: z.array(z.object({ term: Short, definition: Rich, example: Rich.optional() })).min(1).max(L.maxEntries),
});
const VocabularyBlock = z.object({
  type: z.literal("vocabulary"),
  title: Short.optional(),
  lang: Lang,
  items: z
    .array(
      z.object({
        term: Short,
        translation: Short,
        phonetics: Short.optional(),
        partOfSpeech: Short.optional(),
        example: Rich.optional(),
        exampleTranslation: Rich.optional(),
      }),
    )
    .min(1)
    .max(L.maxEntries),
});
const WorkedExampleBlock = z.object({
  type: z.literal("worked_example"),
  title: Short.optional(),
  statement: Rich,
  figure: FigureSchema.optional(),
  /** Cuenta en columna o factorización que la app pinta resuelta. */
  operation: DocOperationSchema.optional(),
  steps: z.array(z.object({ text: Rich, work: z.string().trim().min(1).max(400).optional() })).min(1).max(12),
  answer: Rich,
  /** Comprobación final («Comprobamos: 12 · 4 = 48»). */
  check: Rich.optional(),
});
const FigureBlock = z.object({
  type: z.literal("figure"),
  svg: FigureSchema,
  /** Descripción para quien no ve la figura (obligatoria). */
  alt: Short,
  caption: Short.optional(),
  size: z.enum(["s", "m", "l"]).optional(),
});
const TimelineBlock = z.object({
  type: z.literal("timeline"),
  title: Short.optional(),
  events: z
    .array(z.object({ when: Short, sortKey: z.number().optional(), title: Short, text: Rich.optional() }))
    .min(2)
    .max(L.maxEvents),
});

export interface TreeNode {
  label: string;
  text?: string;
  children?: TreeNode[];
}
const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({ label: Short, text: Rich.optional(), children: z.array(TreeNodeSchema).min(1).max(8).optional() }),
);
/** Esquema / mapa conceptual: «braces» = esquema de llaves (el de clase), «tree» = árbol, «mindmap» = mapa. */
const TreeBlock = z.object({
  type: z.literal("tree"),
  title: Short.optional(),
  layout: z.enum(["braces", "tree", "mindmap"]).default("braces"),
  root: TreeNodeSchema,
});
const FlashcardsBlock = z.object({
  type: z.literal("flashcards"),
  title: Short.optional(),
  frontLang: Lang.optional(),
  backLang: Lang.optional(),
  cards: z
    .array(z.object({ front: z.string().trim().min(1).max(600), back: z.string().trim().min(1).max(1200), hint: Short.optional() }))
    .min(1)
    .max(L.maxCards),
});
/** Texto de lectura: párrafos separados por una línea en blanco. */
const PassageBlock = z.object({
  type: z.literal("passage"),
  title: Short.optional(),
  source: Short.optional(),
  lang: Lang.optional(),
  text: z.string().trim().min(1).max(L.maxPassage),
  numberLines: z.boolean().optional(),
});

const QuestionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), id: QId, prompt: Rich, answer: Rich, lines: z.number().int().min(1).max(12).optional() }),
  z.object({
    kind: z.literal("choice"),
    id: QId,
    prompt: Rich,
    options: z.array(Short).min(2).max(6),
    correct: z.number().int().min(0),
    explanation: Rich.optional(),
  }),
  z.object({ kind: z.literal("true_false"), id: QId, prompt: Rich, correct: z.boolean(), explanation: Rich.optional() }),
  /** Huecos `{{1}}`, `{{2}}`... en el enunciado; `answers[i]` es la respuesta del hueco i+1. */
  z.object({ kind: z.literal("fill"), id: QId, prompt: Rich, answers: z.array(Short).min(1).max(10) }),
]);
export type StudyQuestion = z.infer<typeof QuestionSchema>;
/** Preguntas de autocontrol o de comprensión: SIEMPRE con su respuesta (la clave del PDF sale de aquí). */
const QuestionsBlock = z.object({ type: z.literal("questions"), title: Short.optional(), items: z.array(QuestionSchema).min(1).max(L.maxQuestions) });
/** Texto del dictado: SOLO para el adulto. Al niño nunca le llega (ver redactStudyDocForChild). */
const DictationBlock = z.object({
  type: z.literal("dictation"),
  title: Short.optional(),
  lang: Lang.optional(),
  text: z.string().trim().min(1).max(6000),
  /** Lo que se trabaja («b/v», «tildes en agudas»...). */
  focus: z.array(Short).min(1).max(8).optional(),
  /** Consejo de ritmo para el adulto. */
  pace: Short.optional(),
  /** Renglones de la hoja del niño. */
  lines: z.number().int().min(4).max(30),
});
const WritingPromptBlock = z.object({
  type: z.literal("writing_prompt"),
  title: Short.optional(),
  prompt: Rich,
  genre: Short.optional(),
  minWords: z.number().int().min(10).max(1000).optional(),
  maxWords: z.number().int().min(10).max(1500).optional(),
  checklist: z.array(Short).min(1).max(10).optional(),
  /** Texto modelo: cuenta como respuesta (se oculta al niño si no ve las respuestas). */
  model: Rich.optional(),
});
const RubricBlock = z.object({
  type: z.literal("rubric"),
  title: Short.optional(),
  criteria: z
    .array(
      z.object({
        name: Short,
        levels: z.array(z.object({ label: Short, points: z.number().min(0).max(100).optional(), descriptor: Rich })).min(2).max(4),
      }),
    )
    .min(1)
    .max(8),
});
/** Espacio para escribir en papel (en pantalla: «Hazlo en tu cuaderno»). */
const AnswerSpaceBlock = z.object({
  type: z.literal("answer_space"),
  lines: z.number().int().min(1).max(30),
  style: z.enum(["lines", "grid", "blank"]).default("lines"),
  label: Short.optional(),
});
/** Salto de página en papel (en pantalla no se ve). */
const PageBreakBlock = z.object({ type: z.literal("page_break") });

export const StudyBlockSchema = z.discriminatedUnion("type", [
  HeadingBlock,
  ParagraphBlock,
  CalloutBlock,
  ListBlock,
  TableBlock,
  FormulaBlock,
  DefinitionsBlock,
  VocabularyBlock,
  WorkedExampleBlock,
  FigureBlock,
  TimelineBlock,
  TreeBlock,
  FlashcardsBlock,
  PassageBlock,
  QuestionsBlock,
  DictationBlock,
  WritingPromptBlock,
  RubricBlock,
  AnswerSpaceBlock,
  PageBreakBlock,
]);
export type StudyBlock = z.infer<typeof StudyBlockSchema>;
export type StudyBlockType = StudyBlock["type"];

/* ---------- Documento ---------- */

export const StudyDocSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  kind: z.enum(STUDY_DOC_KINDS),
  title: z.string().trim().min(1).max(L.maxTitle),
  subtitle: Short.optional(),
  language: Lang.default("es"),
  /** «Al terminar sabrás...». */
  goals: z.array(Short).min(1).max(6).optional(),
  estimatedMinutes: z.number().int().min(1).max(180).optional(),
  print: z
    .object({
      columns: z.union([z.literal(1), z.literal(2)]).optional(),
      orientation: z.enum(["portrait", "landscape"]).optional(),
      cardsPerPage: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]).optional(),
    })
    .optional(),
  blocks: z.array(StudyBlockSchema).min(1).max(L.maxBlocks),
});
export type StudyDoc = z.infer<typeof StudyDocSchema>;

/** Datos del envoltorio con que se publica un documento (import de máquina y Vía C). */
export const StudyDocMetaSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/, "id de documento no válido"),
  /** null = catálogo GLOBAL; id de tutor = PRIVADO del hogar. */
  ownerId: z.string().min(1).nullable(),
  subjectId: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "id de materia no válido"),
  gradeBand: z.string().regex(/^[A-Z]{2,5}-\d{1,2}$/, "nivel no válido"),
  skillId: z.string().min(1).max(200).nullable().optional(),
  pathId: z.string().min(1).max(200).nullable().optional(),
  courseId: z.string().min(1).max(200).nullable().optional(),
  moduleIndex: z.number().int().min(0).max(50).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  childAnswers: z.boolean().optional(),
});
export type StudyDocMeta = z.infer<typeof StudyDocMetaSchema>;
/** Envoltorio + cuerpo: lo que manda la skill (sirve para pre-validar un import entero). */
export const StudyDocEnvelopeSchema = StudyDocMetaSchema.extend({ body: StudyDocSchema });

/* ---------- Recorrido ---------- */

type Visit = (value: string, path: string, key: string) => void;
/** Recorre todas las cadenas del documento con su ruta legible («blocks[3].items[1].prompt»). */
function walkStrings(value: unknown, path: string, key: string, visit: Visit): void {
  if (typeof value === "string") visit(value, path, key);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, key, visit));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, k, visit);
}

/** Bytes UTF-8 de una cadena (a mano: el lib de shared es ES2023 sin TextEncoder). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Serialización canónica (el orden de las claves lo fija el esquema): base del hash de versión. */
export function canonicalStudyDocJson(doc: StudyDoc): string {
  return JSON.stringify(doc);
}

export function studyDocBytes(doc: StudyDoc): number {
  return utf8Bytes(canonicalStudyDocJson(doc));
}

/* ---------- Validación (self-check, como validateExercise) ---------- */

const EMOJI = /\p{Emoji_Presentation}|️/u;
const SVG_DANGER = /<script|<foreignObject|<image|href|\son[a-z]+\s*=|url\(/i;
const SVG_KEYS = new Set(["svg", "figure"]);
// Claves que no son texto «rico» (notación propia o identificadores): sin chequeo de `$`/`**`.
const NOT_RICH = new Set(["svg", "figure", "expr", "id", "lang", "frontLang", "backLang", "language", "kind", "type", "variant", "layout", "style", "symbol"]);

const unescapedDollars = (s: string) => (s.replace(/\\\$/g, "").match(/\$/g) ?? []).length;
const blankMarks = (s: string) => (s.match(/\{\{\d+\}\}/g) ?? []).map((m) => Number(m.slice(2, -2)));

function treeShape(node: TreeNode, depth = 1): { depth: number; nodes: number } {
  let d = depth;
  let n = 1;
  for (const ch of node.children ?? []) {
    const s = treeShape(ch, depth + 1);
    d = Math.max(d, s.depth);
    n += s.nodes;
  }
  return { depth: d, nodes: n };
}

const fail = (reason: string): Verdict => ({ ok: false, reason });

/**
 * Comprobaciones que el esquema no expresa: notación equilibrada, sin emojis (política del proyecto), SVG
 * seguro, coherencia de preguntas, tablas, esquemas y líneas del tiempo, mínimos de cada tipo de documento y
 * tope de tamaño. Devuelve el PRIMER problema con su ruta («blocks[7].items[2]: ...»).
 */
export function validateStudyDoc(doc: StudyDoc): Verdict {
  let problem: string | null = null;
  let figures = 0;
  walkStrings(doc, "", "", (s, path, key) => {
    if (problem) return;
    if (EMOJI.test(s)) problem = `${path}: sin emojis`;
    else if (SVG_KEYS.has(key)) {
      figures++;
      if (utf8Bytes(s) > L.maxSvgBytes) problem = `${path}: SVG de más de ${L.maxSvgBytes} bytes`;
      else if (SVG_DANGER.test(s)) problem = `${path}: SVG con elementos o atributos no permitidos`;
    } else if (!NOT_RICH.has(key)) {
      if (unescapedDollars(s) % 2 !== 0) problem = `${path}: \`$\` sin cerrar (usa \\$ para un dólar literal)`;
      else if ((s.match(/\*\*/g) ?? []).length % 2 !== 0) problem = `${path}: \`**\` sin cerrar`;
    }
  });
  if (problem) return fail(problem);
  if (figures > L.maxFigures) return fail(`como mucho ${L.maxFigures} figuras por documento`);

  const ids = new Set<string>();
  const count = { headings: 0, cards: 0, entries: 0, worked: 0, treeNodes: 0, events: 0, passages: 0, questions: 0, dictations: 0, prompts: 0, rubrics: 0 };

  for (const [i, b] of doc.blocks.entries()) {
    const at = `blocks[${i}]`;
    switch (b.type) {
      case "heading":
        count.headings++;
        break;
      case "callout":
        if (!b.text && !b.items) return fail(`${at}: el recuadro necesita texto o lista`);
        break;
      case "table":
        for (const [r, row] of b.rows.entries())
          if (row.length !== b.header.length) return fail(`${at}.rows[${r}]: tiene ${row.length} celdas y la cabecera ${b.header.length}`);
        break;
      case "definitions":
      case "vocabulary":
        count.entries += b.items.length;
        break;
      case "worked_example":
        count.worked++;
        if (b.operation?.type === "column_operation") {
          const why = columnSpecProblem({ operation: b.operation.operation, operands: b.operation.operands, decimals: b.operation.decimals });
          if (why) return fail(`${at}.operation: ${why}`);
        }
        break;
      case "timeline": {
        count.events += b.events.length;
        const keys = b.events.map((e) => e.sortKey);
        const withKey = keys.filter((k) => k !== undefined).length;
        if (withKey > 0 && withKey !== keys.length) return fail(`${at}: si un evento lleva sortKey, todos deben llevarlo`);
        for (let k = 1; k < keys.length; k++)
          if (withKey > 0 && (keys[k] as number) < (keys[k - 1] as number)) return fail(`${at}.events[${k}]: sortKey desordenado`);
        break;
      }
      case "tree": {
        const s = treeShape(b.root);
        if (s.depth > L.maxTreeDepth) return fail(`${at}: el esquema tiene ${s.depth} niveles (máximo ${L.maxTreeDepth})`);
        if (s.nodes > L.maxTreeNodes) return fail(`${at}: el esquema tiene ${s.nodes} nodos (máximo ${L.maxTreeNodes})`);
        count.treeNodes += s.nodes;
        break;
      }
      case "flashcards":
        count.cards += b.cards.length;
        break;
      case "passage":
        count.passages++;
        break;
      case "questions":
        count.questions += b.items.length;
        for (const [q, it] of b.items.entries()) {
          const qat = `${at}.items[${q}]`;
          if (ids.has(it.id)) return fail(`${qat}: id de pregunta repetido (${it.id})`);
          ids.add(it.id);
          if (it.kind === "choice") {
            if (it.correct >= it.options.length) return fail(`${qat}: correct fuera de rango`);
            if (new Set(it.options).size !== it.options.length) return fail(`${qat}: opciones repetidas`);
          }
          if (it.kind === "fill") {
            const marks = blankMarks(it.prompt);
            if (marks.length !== it.answers.length) return fail(`${qat}: ${marks.length} huecos y ${it.answers.length} respuestas`);
            if (marks.some((m, k) => m !== k + 1)) return fail(`${qat}: los huecos deben ir numerados {{1}}, {{2}}... en orden`);
          }
        }
        break;
      case "dictation":
        count.dictations++;
        break;
      case "writing_prompt":
        count.prompts++;
        if (b.minWords && b.maxWords && b.minWords > b.maxWords) return fail(`${at}: minWords mayor que maxWords`);
        break;
      case "rubric": {
        count.rubrics++;
        const n = b.criteria[0]!.levels.length;
        if (b.criteria.some((c) => c.levels.length !== n)) return fail(`${at}: todos los criterios deben tener los mismos niveles`);
        break;
      }
      default:
        break;
    }
  }

  // Mínimos de cada tipo de documento: que el «resumen» sea un resumen y las «tarjetas», tarjetas.
  const need: Record<StudyDocKind, [boolean, string]> = {
    summary: [count.headings >= 1 && doc.blocks.length >= 3, "un resumen necesita al menos un título y 3 bloques"],
    cheatsheet: [doc.blocks.length >= 3, "una hoja de trucos necesita al menos 3 bloques"],
    flashcards: [count.cards >= 6, "un mazo necesita al menos 6 tarjetas"],
    glossary: [count.entries >= 5, "un glosario necesita al menos 5 entradas (definitions o vocabulary)"],
    worked_examples: [count.worked >= 2, "hacen falta al menos 2 ejemplos resueltos"],
    concept_map: [count.treeNodes >= 4, "un esquema necesita un bloque tree con al menos 4 nodos"],
    timeline: [count.events >= 3, "una línea del tiempo necesita al menos 3 eventos"],
    reading: [count.passages >= 1 && count.questions >= 1, "la comprensión lectora necesita un texto (passage) y preguntas"],
    dictation: [count.dictations >= 1, "el dictado necesita un bloque dictation"],
    writing: [count.prompts >= 1 && count.rubrics >= 1, "la redacción necesita la consigna (writing_prompt) y una rúbrica"],
  };
  const [ok, why] = need[doc.kind];
  if (!ok) return fail(why);

  const bytes = studyDocBytes(doc);
  if (bytes > L.maxBytes) return fail(`el documento ocupa ${bytes} bytes (máximo ${L.maxBytes})`);
  return { ok: true };
}

/** Avisos que NO bloquean (la skill y el builder los muestran para mejorar el documento). */
export function lintStudyDoc(doc: StudyDoc): string[] {
  const out: string[] = [];
  const types = new Set(doc.blocks.map((b) => b.type));
  const hasRemember = doc.blocks.some((b) => b.type === "callout" && b.variant === "remember");
  if (doc.kind === "summary" && !hasRemember) out.push("resumen sin recuadro «Recuerda» (callout remember)");
  if (doc.kind === "summary" && !types.has("questions")) out.push("resumen sin preguntas finales «Comprueba lo que sabes»");
  if (doc.kind === "writing" && !types.has("answer_space")) out.push("redacción sin answer_space: en papel no habrá renglones extra");
  let chars = 0;
  walkStrings(doc, "", "", (s, path, key) => {
    if (SVG_KEYS.has(key)) {
      if (/#[0-9a-f]{3,6}\b/i.test(s)) out.push(`${path}: colores fijos en el SVG (usa currentColor)`);
      return;
    }
    chars += s.length;
    if (key === "text" && s.length > 1200 && !path.includes("passage")) out.push(`${path}: párrafo muy largo (${s.length} caracteres)`);
  });
  if (doc.kind === "cheatsheet" && chars > 6000) out.push(`hoja de trucos de ${chars} caracteres: pasará de 2 páginas`);
  return out;
}

/* ---------- Versión para el niño ---------- */

/** Pregunta tal como le llega al niño: sin respuestas si el tutor no quiere que las vea. */
export type ChildStudyQuestion =
  | (Omit<Extract<StudyQuestion, { kind: "open" }>, "answer"> & { answer?: string })
  | (Omit<Extract<StudyQuestion, { kind: "choice" }>, "correct" | "explanation"> & { correct?: number; explanation?: string })
  | (Omit<Extract<StudyQuestion, { kind: "true_false" }>, "correct" | "explanation"> & { correct?: boolean; explanation?: string })
  | (Omit<Extract<StudyQuestion, { kind: "fill" }>, "answers"> & { answers?: string[] });

/** Bloque visible: el del tutor (completo) también encaja aquí, así que la web pinta este tipo en los dos casos. */
export type ViewableStudyBlock =
  | Exclude<StudyBlock, { type: "questions" | "dictation" | "writing_prompt" }>
  | (Omit<Extract<StudyBlock, { type: "questions" }>, "items"> & { items: ChildStudyQuestion[] })
  | (Omit<Extract<StudyBlock, { type: "dictation" }>, "text" | "focus" | "pace"> & { text?: string; focus?: string[]; pace?: string })
  | (Omit<Extract<StudyBlock, { type: "writing_prompt" }>, "model"> & { model?: string });
export type ViewableStudyDoc = Omit<StudyDoc, "blocks"> & { blocks: ViewableStudyBlock[] };

function redactQuestion(q: StudyQuestion): ChildStudyQuestion {
  switch (q.kind) {
    case "open": {
      const { answer: _a, ...rest } = q;
      return rest;
    }
    case "choice":
    case "true_false": {
      const { correct: _c, explanation: _e, ...rest } = q;
      return rest;
    }
    case "fill": {
      const { answers: _a, ...rest } = q;
      return rest;
    }
  }
}

/**
 * Lo que puede ver el NIÑO. El texto del dictado no le llega NUNCA (se lo dicta un adulto). Sin `answers`
 * se quitan además las respuestas de las preguntas y el texto modelo de la redacción. Los ejemplos resueltos
 * y el reverso de las tarjetas se quedan: son el contenido de estudio. Pura: no toca el documento de entrada.
 */
export function redactStudyDocForChild(doc: StudyDoc, opts: { answers: boolean }): ViewableStudyDoc {
  const blocks = doc.blocks.map((b): ViewableStudyBlock => {
    if (b.type === "dictation") return { type: "dictation", ...(b.title ? { title: b.title } : {}), ...(b.lang ? { lang: b.lang } : {}), lines: b.lines };
    if (opts.answers) return structuredCloneJson(b);
    if (b.type === "questions") return { ...structuredCloneJson(b), items: b.items.map(redactQuestion) };
    if (b.type === "writing_prompt") {
      const { model: _m, ...rest } = structuredCloneJson(b);
      return rest;
    }
    return structuredCloneJson(b);
  });
  return { ...structuredCloneJson({ ...doc, blocks: [] }), blocks };
}

function structuredCloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/* ---------- Estadísticas (se guardan para listar sin leer el cuerpo) ---------- */

export interface StudyDocStats {
  words: number;
  blocks: number;
  figures: number;
  questions: number;
  cards: number;
  entries: number;
  events: number;
}

export function studyDocStats(doc: StudyDoc): StudyDocStats {
  const s: StudyDocStats = { words: 0, blocks: doc.blocks.length, figures: 0, questions: 0, cards: 0, entries: 0, events: 0 };
  walkStrings(doc.blocks, "", "", (str, _path, key) => {
    if (SVG_KEYS.has(key)) {
      s.figures++;
      return;
    }
    if (NOT_RICH.has(key)) return;
    s.words += str.split(/\s+/).filter(Boolean).length;
  });
  for (const b of doc.blocks) {
    if (b.type === "questions") s.questions += b.items.length;
    if (b.type === "flashcards") s.cards += b.cards.length;
    if (b.type === "definitions" || b.type === "vocabulary") s.entries += b.items.length;
    if (b.type === "timeline") s.events += b.events.length;
  }
  return s;
}
