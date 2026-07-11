import { z } from "zod";

/** Texto multi-idioma: { es: "...", en: "...", ca: "..." } con fallback en la app. */
export const LocaleTextSchema = z.record(z.string(), z.string());
export type LocaleText = z.infer<typeof LocaleTextSchema>;

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

/** Campos comunes a todos los tipos de ejercicio. */
const BaseExercise = z.object({
  exerciseId: z.string(),
  packageId: z.string(),
  schemaVersion: z.string().default("1.0.0"),
  language: z.string(),
  skillId: z.string(),
  stem: z.string(),
  difficulty: DifficultySchema,
});

export const MultipleChoiceSchema = BaseExercise.extend({
  type: z.literal("multiple_choice"),
  options: z
    .array(z.object({ id: z.string(), text: z.string(), isCorrect: z.boolean() }))
    .min(2),
});

export const NumericSchema = BaseExercise.extend({
  type: z.literal("numeric"),
  answer: z.object({
    value: z.number(),
    tolerance: z.number().default(0),
    unit: z.string().optional(),
  }),
});

export const TrueFalseSchema = BaseExercise.extend({
  type: z.literal("true_false"),
  answer: z.object({ value: z.boolean() }),
});

/** Unión discriminada por `type`. Se ampliará con el resto de tipos. */
export const ExerciseSchema = z.discriminatedUnion("type", [
  MultipleChoiceSchema,
  NumericSchema,
  TrueFalseSchema,
]);
export type Exercise = z.infer<typeof ExerciseSchema>;
