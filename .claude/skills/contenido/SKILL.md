---
name: contenido
description: "Genera contenido educativo (ejercicios de los 7 tipos) para smartkids, en dos vías: (A) desde una descripción en lenguaje natural del usuario, y (B) desde material que un tutor sube por la app (fotos, PDF, texto). Úsala cuando el usuario pida 'generar contenido', 'crear ejercicios de <asignatura/nivel>', o 'procesar las solicitudes de contenido de los tutores'."
trigger: /contenido
---

# /contenido

Generador de contenido de smartkids. Convierte una petición (o el material subido por un tutor) en ejercicios validados y los publica en la D1, listos para jugar.

## Uso

```
/contenido <descripción>       # Vía A: "genera 30 ejercicios de mates 5º ESO sobre fracciones"
/contenido pendientes          # Vía B: procesa las solicitudes de contenido subidas por tutores
```

## Contexto imprescindible (léelo antes de actuar)

- El modelo del ejercicio es ÚNICO y vive en `packages/shared` (`ExerciseSchema`, 7 tipos: `multiple_choice`, `numeric`, `fill_in_blank`, `true_false`, `ordering`, `matching`, `step_problem`). El pipeline y la API lo comparten. NO inventes otro formato.
- El pipeline es `tools/content-gen/src/generate.ts`. Se conduce con una **spec JSON** (ver `tools/content-gen/spec.example.json`). Con `ANTHROPIC_API_KEY` usa Claude (`claude-opus-4-8`); si no, cae a `--mock` (muestras deterministas).
- Publicar es **manual y con confirmación** cuando toca producción. En local es libre.
- Convención de nombres: `packageId = pkg_{subject}_{gradeband}_{tema}_v{n}`; `skillId` estable y semántico (p. ej. `MATH.ESO5.FRAC.MUL`).
- Contenido **global** = `ownerId: null` (catálogo, visible por curso). Contenido **privado del hogar** (Vía B) = `ownerId: <id del tutor>` + se asigna a niños concretos.

## Qué debes hacer cuando te invoquen

### Vía A — generar desde una descripción

1. **Construye la spec** a partir de la petición del usuario. Pregunta SOLO lo que falte y no puedas inferir (asignatura, nivel, tema/skill, tipos, cantidad). Rellena una spec como `spec.example.json` y escríbela en `tools/content-gen/spec.json`. Usa `ownerId: null` (catálogo global).
2. **Genera**: `pnpm --filter @smartkids/content-gen run generate -- --spec tools/content-gen/spec.json` (añade `--mock` para prueba sin coste). Requiere `ANTHROPIC_API_KEY` para generación real.
3. **Revisa la calidad** de `tools/content-gen/out/<packageId>.json`: enunciados claros, respuestas CORRECTAS (comprueba tú la aritmética/los datos — el self-check valida coherencia, no la verdad del mundo), distractores plausibles basados en errores típicos, feedback con solución trabajada. Si algo falla, ajusta la spec/instrucciones y regenera.
4. **Publica en local**: `pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local --file="tools/content-gen/out/<packageId>.sql"`.
5. **Publica en producción SOLO con confirmación explícita del usuario**: la misma orden con `--remote`. Recuerda que el `skillId` debe existir en un curso que los niños tengan asignado (asignatura+nivel) para que lo vean.

### Vía B — generar desde material subido por un tutor

1. **Lista las solicitudes pendientes**: `GET /api/admin/content-requests?status=uploaded` con cabecera `Authorization: Bearer $CONTENT_IMPORT_TOKEN` (o consulta la tabla `content_requests`). Cada solicitud trae `ownerId` (tutor), `childId` (destino), `title`, `instructions`, `subjectId`/`gradeBand` (pistas) y sus `assets`.
2. **Descarga los assets si los hay**: `GET /api/admin/content-requests/:id/assets/:assetId` (mismo Bearer) devuelve el binario. **Una solicitud puede NO tener `assets`** (petición SOLO de texto): entonces no hay nada que descargar y generas a partir de `title` + `instructions` (como una spec de la Vía A, pero publicando privado).
   La solicitud trae además su **config**: `numQuestions` (cuántas preguntas, por defecto 20), `pointsPerCorrect` (puntos por acierto) y `modules` (1 = ficha única; >1 = path con N módulos).
3. **Genera** `numQuestions` ejercicios en total, de los tipos adecuados, siguiendo `title` + `instructions`. Con material: si hay `ANTHROPIC_API_KEY`, usa Claude multimodal (`claude-opus-4-8`, salida `ExerciseSchema`, bloques `image` para fotos y `document` para PDF); sin key, extrae el texto (p. ej. Node `pdf-parse`) y redáctalos tú. Sin material (petición de texto), genera directamente de la descripción del tutor.
4. **Valida** cada ejercicio con `ExerciseSchema` + `validateExercise`. Decide la **estructura**: si `modules` = 1, un solo skill; si `modules` > 1, reparte los ejercicios en N skills-módulo que forman un **path** (comparten `pathId` = `path_<requestId>` y `pathName` = el `title`; cada uno con `moduleIndex` 0..N-1 y su propio `skill.id`, p. ej. `PRIV.<algo>.M1`, `.M2`...).
5. **Publica** cada skill vía `POST /api/admin/content/import` (Bearer):
   - `package.ownerId` = `skill.ownerId` = el `ownerId` de la solicitud (privado del hogar).
   - `skill.coinsPerCorrect` = `pointsPerCorrect` de la solicitud.
   - `skill.subjectId`/`gradeBand` alineados con un curso del niño (para que se vea en su galaxia/inicio).
   - Para un path: pon `skill.pathId`, `skill.pathName` y `skill.moduleIndex` en cada módulo.
   - `assign.childIds` = `[childId]` de la solicitud.
   - `requestId` = id de la solicitud **solo en la ÚLTIMA llamada** (marca `published` y envía UN email de aviso al tutor).
6. Confirma al usuario el resultado (nº de ejercicios, módulos/path, a qué niño se asignó, email enviado).

## Reglas (no las saltes)

- **Nunca** publiques en `--remote` sin que el usuario lo confirme en ese momento.
- **Nunca** metas emojis en el contenido (política del proyecto). Textos en el idioma de la spec.
- El `payload` de D1 lo genera `toStoredPayload()`; no montes el JSON a mano.
- Si un ejercicio no pasa `validateExercise`, NO lo publiques: corrígelo o descártalo.
- Para contenido privado (Vía B), respeta el ámbito del hogar: `ownerId` del tutor y asignación solo a sus niños.
- Reporta con honestidad: cuántos se generaron, cuántos se rechazaron y por qué.
