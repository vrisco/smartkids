// Curso escolar del niño (LOMLOE). Mismo formato que `courses.grade_band` y que valida la API
// (GRADE_BAND_RE). Un valor fuera de la lista (el "ESO-5" que se fijaba antes a todos) = sin definir.
export const GRADE_BANDS = [
  "PRI-1",
  "PRI-2",
  "PRI-3",
  "PRI-4",
  "PRI-5",
  "PRI-6",
  "ESO-1",
  "ESO-2",
  "ESO-3",
  "ESO-4",
  "BACH-1",
  "BACH-2",
] as const;
export type GradeBand = (typeof GRADE_BANDS)[number];

export function isGradeBand(v: string | null | undefined): v is GradeBand {
  return Boolean(v) && (GRADE_BANDS as readonly string[]).includes(v!);
}
