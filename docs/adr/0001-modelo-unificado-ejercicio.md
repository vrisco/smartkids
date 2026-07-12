# ADR 0001 — Modelo unificado del ejercicio (7 tipos, fuente única de verdad)

**Estado:** Aceptado (2026-07-12, M9)

## Contexto

Había **tres modelos divergentes** del ejercicio y ninguno era la verdad:
- `packages/shared/src/exercise.ts` (Zod) modelaba 3 de 7 tipos, con `options`+`isCorrect` como campos
  de primer nivel, y **no lo importaba nadie**.
- El pipeline `tools/content-gen` tenía su propio `RawExerciseSchema` (solo `multiple_choice`).
- D1 persistía todo en una columna `payload` JSON (`{options, feedback}`), sin tipado.

Consecuencias: solo se podía jugar opción múltiple; el grading vivía en la API duplicando la forma del payload;
y añadir un tipo obligaba a tocar tres sitios inconsistentes. Además el motor confiaba en el cliente para el acierto.

## Decisión

**`packages/shared` es la fuente ÚNICA de verdad del ejercicio**, importada por la API Y la web:
- `exercise.ts`: `ExerciseSchema` = unión discriminada de los **7 tipos** (`multiple_choice`, `numeric`,
  `fill_in_blank`, `true_false`, `ordering`, `matching`, `step_problem`) + `AnswerSchema` (lo que envía el niño).
- `grading.ts`: `grade(ex, answer)` corrige EN SERVIDOR; `redactForClient(ex)` produce lo único que se manda al
  cliente (sin la solución); `toStoredPayload()/exerciseFromRow()` mapean ↔ la columna `payload` de D1;
  `validateExercise()` hace self-check (la clave canónica corrige acierto) y lo reusa el pipeline.
- La web importa **solo tipos** (`import type`) → `zod` no entra en su bundle.
- `tsconfig.base.json` activa `allowImportingTsExtensions` y los imports internos de `shared` llevan `.ts`, para
  que el pipeline pueda importar `shared` bajo `node --experimental-strip-types`.

## Consecuencias

- (+) Un solo sitio para añadir/validar un tipo; grading y redacción compartidos sin duplicar.
- (+) Anti-cheat real: el cliente nunca recibe la respuesta (`redactForClient`) y el servidor decide (`grade`).
- (+) El pipeline valida con la MISMA lógica que corrige en producción (`validateExercise`).
- (−) `shared` deja de ser trivial: cambiarlo afecta a api, web y pipeline (typecheck de los tres lo cubre).
- (−) La dependencia de `allowImportingTsExtensions` acopla el build a esa opción (segura porque nada emite con `tsc`).

Verificado end-to-end (los 7 tipos sirven, corrigen acierto/fallo y no filtran la solución).
