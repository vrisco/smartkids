// Catálogo de materias y de documentos de estudio. Solo valores de TIEMPO DE EJECUCIÓN y SIN zod: la web los
// importa desde `@smartkids/shared/catalog` (igual que `./arith`) sin arrastrar zod al bundle. El esquema de los
// documentos vive en `studydoc.ts`; aquí, lo que necesitan a la vez la API, la web, la skill y el builder.

/** Tipos de documento de estudio («Apuntes»): se ven en la app y se imprimen. */
export const STUDY_DOC_KINDS = [
  "summary",
  "cheatsheet",
  "flashcards",
  "glossary",
  "worked_examples",
  "concept_map",
  "timeline",
  "reading",
  "dictation",
  "writing",
] as const;
export type StudyDocKind = (typeof STUDY_DOC_KINDS)[number];

/** Nombre de cada tipo (`esLower` para frases: «45 ejercicios, resumen y hoja de trucos»). */
export const STUDY_DOC_KIND_LABELS: Record<StudyDocKind, { es: string; en: string; esLower: string }> = {
  summary: { es: "Resumen", en: "Summary", esLower: "resumen" },
  cheatsheet: { es: "Hoja de trucos", en: "Cheat sheet", esLower: "hoja de trucos" },
  flashcards: { es: "Tarjetas de estudio", en: "Flashcards", esLower: "tarjetas de estudio" },
  glossary: { es: "Glosario y vocabulario", en: "Glossary and vocabulary", esLower: "glosario" },
  worked_examples: { es: "Ejemplos resueltos", en: "Worked examples", esLower: "ejemplos resueltos" },
  concept_map: { es: "Esquema", en: "Concept map", esLower: "esquema" },
  timeline: { es: "Línea del tiempo", en: "Timeline", esLower: "línea del tiempo" },
  reading: { es: "Comprensión lectora", en: "Reading comprehension", esLower: "comprensión lectora" },
  dictation: { es: "Dictado", en: "Dictation", esLower: "dictado" },
  writing: { es: "Expresión escrita", en: "Writing", esLower: "expresión escrita" },
};

/** Lo que puede pedir una solicitud de contenido (Vía B): el banco de ejercicios y/o documentos. */
export const REQUEST_OUTPUTS = ["exercises", ...STUDY_DOC_KINDS] as const;
export type RequestOutput = (typeof REQUEST_OUTPUTS)[number];
/** Lo que se marca por defecto en una solicitud nueva. */
export const DEFAULT_REQUEST_OUTPUTS: RequestOutput[] = ["exercises", "summary", "cheatsheet"];
/** Lo que significaba una solicitud anterior a los documentos (`outputs` NULL en la BD). */
export const LEGACY_REQUEST_OUTPUTS: RequestOutput[] = ["exercises"];

/**
 * ¿Ve el niño las respuestas en la app («Ver solución»)? Es solo el valor inicial: el tutor lo cambia por
 * documento. En comprensión lectora y redacción no, para que piense antes de mirar; en el dictado da igual
 * (su texto no le llega nunca).
 */
export const CHILD_ANSWERS_DEFAULT: Record<StudyDocKind, boolean> = {
  summary: true,
  cheatsheet: true,
  flashcards: true,
  glossary: true,
  worked_examples: true,
  concept_map: true,
  timeline: true,
  reading: false,
  dictation: false,
  writing: false,
};

/* ---------- Materias ---------- */

/** Familia de una materia: decide el formato del papel y los documentos sugeridos. */
export type SubjectFamily = "math" | "language" | "foreign" | "science" | "social" | "generic";

export interface SubjectInfo {
  id: string;
  family: SubjectFamily;
  nameI18n: { es: string; en: string };
  /** Idioma del contenido de la materia si no es el castellano (idiomas). */
  lang?: string;
}

/** Materias canónicas (ids que propone la UI). La API acepta cualquier id `^[a-z][a-z0-9_]{1,39}$`. */
export const SUBJECTS: SubjectInfo[] = [
  { id: "math", family: "math", nameI18n: { es: "Matemáticas", en: "Maths" } },
  { id: "lengua", family: "language", nameI18n: { es: "Lengua", en: "Spanish language" } },
  { id: "ingles", family: "foreign", lang: "en", nameI18n: { es: "Inglés", en: "English" } },
  { id: "frances", family: "foreign", lang: "fr", nameI18n: { es: "Francés", en: "French" } },
  { id: "naturales", family: "science", nameI18n: { es: "Ciencias naturales", en: "Natural science" } },
  { id: "sociales", family: "social", nameI18n: { es: "Ciencias sociales", en: "Social science" } },
];

/** Documentos que tiene sentido sugerir para cada familia (la skill y el formulario del tutor). */
export const SUGGESTED_DOC_KINDS: Record<SubjectFamily, StudyDocKind[]> = {
  math: ["summary", "cheatsheet", "worked_examples"],
  language: ["summary", "cheatsheet", "reading", "dictation", "writing"],
  foreign: ["glossary", "flashcards", "reading", "dictation", "cheatsheet"],
  science: ["summary", "cheatsheet", "glossary", "concept_map", "flashcards"],
  social: ["summary", "concept_map", "timeline", "glossary", "flashcards"],
  generic: ["summary", "cheatsheet"],
};

// Palabras que delatan la familia. El ORDEN de comprobación importa: «ciencias sociales» es social, no
// ciencia, así que sociales va antes que ciencias.
const FAMILY_WORDS: [SubjectFamily, string[]][] = [
  ["math", ["math", "maths", "mat", "mates", "matematicas", "aritmetica", "geometria", "algebra", "calculo"]],
  ["social", ["sociales", "social", "historia", "geografia", "history", "geography", "economia", "ciudadania"]],
  ["science", ["ciencias", "ciencia", "naturales", "natural", "biologia", "fisica", "quimica", "geologia", "tecnologia", "science", "conocimiento", "medio"]],
  ["foreign", ["ingles", "english", "frances", "french", "aleman", "german", "italiano", "portugues", "idioma", "idiomas", "foreign"]],
  ["language", ["lengua", "castellano", "espanol", "literatura", "lectura", "catalan", "valenciano", "gallego", "euskera", "language"]],
];

/** Familia de una materia a partir de su id o nombre libre («math», «lengua», «Historia de España»...). */
export function subjectFamily(subject?: string | null): SubjectFamily {
  if (!subject) return "generic";
  const known = SUBJECTS.find((s) => s.id === subject);
  if (known) return known.family;
  const words = new Set(
    subject
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  for (const [family, list] of FAMILY_WORDS) if (list.some((w) => words.has(w))) return family;
  return "generic";
}
