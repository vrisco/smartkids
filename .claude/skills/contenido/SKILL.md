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
2. **Descarga los assets** (imágenes y/o documentos): `GET /api/admin/content-requests/:id/assets/:assetId` (mismo Bearer) devuelve el binario. Guarda cada uno; anota su `contentType`/`kind`.
3. **Genera multimodal con Claude** (`claude-opus-4-8`, salida estructurada con `ExerciseSchema`): monta el mensaje con bloques `image` para las fotos y bloques `document` para los PDF, más las `instructions` del tutor. Pide ejercicios de los tipos adecuados al material.
4. **Valida** cada ejercicio con `ExerciseSchema` + `validateExercise` (igual que el pipeline).
5. **Publica como contenido privado** vía `POST /api/admin/content/import` (Bearer) con:
   - `package.ownerId` = `skill.ownerId` = el `ownerId` de la solicitud (privado del hogar).
   - `skill` nuevo y privado (p. ej. `PRIV.<tutorCorto>.<tema>`), `subjectId`/`gradeBand` alineados con un curso del niño.
   - `assign.childIds` = `[childId]` de la solicitud.
   - `requestId` = id de la solicitud → el servidor marca `published` y **envía el email de aviso al tutor**.
6. Confirma al usuario el resultado (nº de ejercicios, a qué niño se asignó, email enviado).

## Reglas (no las saltes)

- **Nunca** publiques en `--remote` sin que el usuario lo confirme en ese momento.
- **Nunca** metas emojis en el contenido (política del proyecto). Textos en el idioma de la spec.
- El `payload` de D1 lo genera `toStoredPayload()`; no montes el JSON a mano.
- Si un ejercicio no pasa `validateExercise`, NO lo publiques: corrígelo o descártalo.
- Para contenido privado (Vía B), respeta el ámbito del hogar: `ownerId` del tutor y asignación solo a sus niños.
- Reporta con honestidad: cuántos se generaron, cuántos se rechazaron y por qué.
