// Icono de cada tipo de documento de estudio (la etiqueta sale de i18n: `studydoc.kind_<tipo>`).
import type { StudyDocKind } from "../../api";
import type { IconName } from "../Icon";

export const KIND_ICON: Record<StudyDocKind, IconName> = {
  summary: "doc",
  cheatsheet: "star",
  flashcards: "cards",
  glossary: "book",
  worked_examples: "pencil",
  concept_map: "tree",
  timeline: "clock",
  reading: "book",
  dictation: "pencil",
  writing: "pencil",
};

/** ¿El niño escribe en este documento impreso? (lleva Nombre/Fecha en la cabecera). */
export const WRITABLE_KINDS: ReadonlySet<StudyDocKind> = new Set(["reading", "dictation", "writing", "worked_examples"]);
