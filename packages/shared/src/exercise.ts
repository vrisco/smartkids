import { z } from "zod";

/** Texto multi-idioma: { es: "...", en: "...", ca: "..." } con fallback en la app. */
export const LocaleTextSchema = z.record(z.string(), z.string());
export type LocaleText = z.infer<typeof LocaleTextSchema>;

/**
 * Fuente ÚNICA de verdad del ejercicio (contenido). La consumen el pipeline de
 * generación (tools/content-gen), el motor de sesión de la API (grading +
 * redacción anti-cheat) y el render de la web. El `payload` JSON de D1 guarda
 * los campos específicos de cada tipo + `feedback` (ver mapping en grading.ts).
 */

export const ExerciseTypeSchema = z.enum([
  "multiple_choice",
  "numeric",
  "fill_in_blank",
  "true_false",
  "ordering",
  "matching",
  "step_problem",
]);
export type ExerciseType = z.infer<typeof ExerciseTypeSchema>;

export const DifficultySchema = z.object({
  level: z.enum(["easy", "medium", "hard"]),
  numeric: z.number().min(0).max(1),
});
export type Difficulty = z.infer<typeof DifficultySchema>;

/** Feedback que se muestra tras responder. `solution` = explicación/solución trabajada opcional. */
export const FeedbackSchema = z.object({
  correct: z.string(),
  incorrect: z.string(),
  solution: z.string().optional(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

/**
 * Config de normalización para respuestas de texto (fill_in_blank / short_text).
 * Todo opcional; los valores por defecto los aplica normalizeText() en grading.ts:
 * caseSensitive=false, accentSensitive=false, trimPunctuation=true.
 */
export const TextNormalizeSchema = z.object({
  caseSensitive: z.boolean().optional(),
  accentSensitive: z.boolean().optional(),
  trimPunctuation: z.boolean().optional(),
});
export type TextNormalize = z.infer<typeof TextNormalizeSchema>;

/**
 * Ilustración opcional del ejercicio: un documento SVG en línea (autocontenido,
 * SIN <script> ni recursos externos) que se muestra sobre el enunciado para
 * presentar la información de forma visual (figuras geométricas, diagramas...).
 * El cliente lo SANEA (allowlist de elementos/atributos) y lo pinta inline, por
 * lo que hereda el color del tema: debe pintar con `currentColor`, no colores
 * fijos. Debe empezar por "<svg".
 */
export const FigureSchema = z
  .string()
  .trim()
  .refine((s) => s.startsWith("<svg") && !/<script/i.test(s), {
    message: "figure debe ser un SVG en línea sin <script>",
  });

/** Campos comunes a todos los tipos de ejercicio. */
const BaseExercise = z.object({
  exerciseId: z.string(),
  packageId: z.string(),
  schemaVersion: z.string().default("1.0.0"),
  language: z.string(),
  skillId: z.string(),
  stem: z.string(),
  figure: FigureSchema.optional(),
  difficulty: DifficultySchema,
  feedback: FeedbackSchema.optional(),
});

/* ---------- Tipos ---------- */

/** Selección: una única opción correcta (isCorrect). */
export const MultipleChoiceSchema = BaseExercise.extend({
  type: z.literal("multiple_choice"),
  options: z.array(z.object({ id: z.string(), text: z.string(), isCorrect: z.boolean() })).min(2),
});
export type MultipleChoiceExercise = z.infer<typeof MultipleChoiceSchema>;

/** Respuesta numérica con tolerancia (operaciones, matemáticas). */
export const NumericSchema = BaseExercise.extend({
  type: z.literal("numeric"),
  answer: z.object({
    value: z.number(),
    tolerance: z.number().min(0).default(0),
    unit: z.string().optional(),
  }),
});
export type NumericExercise = z.infer<typeof NumericSchema>;

/**
 * Rellenar huecos / respuesta de texto corta (lenguas, corrección). El `stem`
 * marca las posiciones con `{{1}}`, `{{2}}`... en orden. Cada hueco lleva su
 * lista de respuestas aceptadas. Un solo hueco = respuesta corta libre.
 */
export const FillInBlankSchema = BaseExercise.extend({
  type: z.literal("fill_in_blank"),
  blanks: z
    .array(
      z.object({
        accept: z.array(z.string()).min(1),
        placeholder: z.string().optional(),
      }),
    )
    .min(1),
  normalize: TextNormalizeSchema.optional(),
});
export type FillInBlankExercise = z.infer<typeof FillInBlankSchema>;

/** Verdadero / falso. */
export const TrueFalseSchema = BaseExercise.extend({
  type: z.literal("true_false"),
  answer: z.object({ value: z.boolean() }),
});
export type TrueFalseExercise = z.infer<typeof TrueFalseSchema>;

/** Ordenar: colocar los ítems en el orden correcto (correctOrder = ids ordenados). */
export const OrderingSchema = BaseExercise.extend({
  type: z.literal("ordering"),
  items: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
  correctOrder: z.array(z.string()).min(2),
});
export type OrderingExercise = z.infer<typeof OrderingSchema>;

/** Emparejar: unir cada elemento de `left` con el de `right` correcto. */
export const MatchingSchema = BaseExercise.extend({
  type: z.literal("matching"),
  left: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
  right: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
  correctPairs: z.array(z.object({ leftId: z.string(), rightId: z.string() })).min(1),
});
export type MatchingExercise = z.infer<typeof MatchingSchema>;

/**
 * Problema por pasos: secuencia ordenada de sub-preguntas, cada una numérica o
 * de texto corto, con su propio enunciado. Se corrige paso a paso.
 */
export const StepSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    prompt: z.string(),
    kind: z.literal("numeric"),
    answer: z.object({
      value: z.number(),
      tolerance: z.number().min(0).default(0),
      unit: z.string().optional(),
    }),
  }),
  z.object({
    id: z.string(),
    prompt: z.string(),
    kind: z.literal("short_text"),
    accept: z.array(z.string()).min(1),
  }),
]);
export type Step = z.infer<typeof StepSchema>;

export const StepProblemSchema = BaseExercise.extend({
  type: z.literal("step_problem"),
  steps: z.array(StepSchema).min(1),
  normalize: TextNormalizeSchema.optional(),
});
export type StepProblemExercise = z.infer<typeof StepProblemSchema>;

/** Unión discriminada por `type` — los 7 tipos. */
export const ExerciseSchema = z.discriminatedUnion("type", [
  MultipleChoiceSchema,
  NumericSchema,
  FillInBlankSchema,
  TrueFalseSchema,
  OrderingSchema,
  MatchingSchema,
  StepProblemSchema,
]);
export type Exercise = z.infer<typeof ExerciseSchema>;

/* ---------- Respuesta del niño (lo que envía el cliente; sin nada de la solución) ---------- */

export const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("multiple_choice"), optionId: z.string() }),
  z.object({ type: z.literal("numeric"), value: z.number() }),
  z.object({ type: z.literal("fill_in_blank"), values: z.array(z.string()) }),
  z.object({ type: z.literal("true_false"), value: z.boolean() }),
  z.object({ type: z.literal("ordering"), order: z.array(z.string()) }),
  z.object({
    type: z.literal("matching"),
    pairs: z.array(z.object({ leftId: z.string(), rightId: z.string() })),
  }),
  z.object({
    type: z.literal("step_problem"),
    steps: z.array(
      z.object({ stepId: z.string(), value: z.number().optional(), text: z.string().optional() }),
    ),
  }),
]);
export type Answer = z.infer<typeof AnswerSchema>;
