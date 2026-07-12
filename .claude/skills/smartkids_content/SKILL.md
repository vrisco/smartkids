---
name: smartkids_content
description: "Genera contenido educativo (ejercicios de los 7 tipos) para smartkids y lo publica en PRODUCCIÓN de forma autónoma, en dos vías: (A) desde una descripción en lenguaje natural del usuario, y (B) procesando el material que los tutores suben por la app (fotos, PDF, texto). Úsala cuando el usuario pida 'generar contenido', 'crear ejercicios de <asignatura/nivel>', o 'procesar las solicitudes de contenido de los tutores'."
---

# /smartkids_content

Generador de contenido de smartkids. Convierte una petición (o el material subido por un tutor) en ejercicios
y los publica en la D1 de **producción**, listos para jugar.

## Uso

```
/smartkids_content <descripción>   # Vía A: "genera 30 ejercicios de mates 5º ESO sobre fracciones"
/smartkids_content pendientes      # Vía B: procesa las solicitudes de contenido subidas por tutores
/smartkids_content                 # sin args: procesa pendientes (Vía B)
```

## Autonomía (LEE ESTO PRIMERO)

Este skill es **autónomo una vez invocado** y **siempre opera contra PRODUCCIÓN**:

- Tienes permiso para **leer, descargar, generar y subir** contenido sin pedir confirmación en cada paso. No abras
  diálogos de "¿publico?" ni pasos de validación local intermedios: haz el ciclo completo de punta a punta y
  reporta el resultado al final.
- **Base de producción:** la API vive en `https://app.smart-kids.uk`. Todas las llamadas de máquina van ahí.
- **Token de máquina:** léelo de `apps/api/.dev.vars` (`CONTENT_IMPORT_TOKEN=...`). Ese mismo token **autentica
  contra producción** (los endpoints `/api/admin/content-requests*` e `/api/admin/content/import` lo aceptan como
  `Authorization: Bearer <token>`). No lo escribas en ficheros versionados ni lo muestres al usuario.
- **No necesitas `ANTHROPIC_API_KEY` ni el pipeline `content-gen`.** En la Vía B eres TÚ quien lee el material y
  redacta los ejercicios directamente. El endpoint `/api/admin/content/import` valida cada ejercicio en servidor
  (`ExerciseSchema` + `validateExercise`) y rechaza el lote entero con `400` si alguno es inválido: esa es tu red
  de seguridad, no hace falta un dry-run local.
- La única razón para **parar y preguntar** es que falte un dato imprescindible que no puedas inferir de la
  solicitud ni del material (p. ej. la Vía A con una descripción demasiado vaga). En la Vía B no preguntes: toda
  la config viene en la solicitud.

## Contexto imprescindible

- El modelo del ejercicio es ÚNICO y vive en `packages/shared` (`ExerciseSchema`, 7 tipos: `multiple_choice`,
  `numeric`, `fill_in_blank`, `true_false`, `ordering`, `matching`, `step_problem`). NO inventes otro formato.
  Reglas de forma (mín. opciones, ids únicos, `correctOrder` permutación, `correctPairs` bijección, huecos
  `{{1}}`, etc.) y el self-check están en `packages/shared/src/grading.ts` (`validateExercise`).
- **Convención de nombres:** `packageId = pkg_{subject}_{gradeband}_{tema}_v{n}`; `skillId` estable y semántico.
  Contenido **global** (Vía A) = `ownerId: null` (catálogo, visible por curso), `skillId` tipo `MATH.ESO5.FRAC.MUL`.
  Contenido **privado del hogar** (Vía B) = `ownerId: <id del tutor>` + asignado a niños concretos, `skillId` tipo
  `PRIV.<TEMA>.<idCortoDeLaSolicitud>` (y `.M1`, `.M2`... si es un path).
- **Ejercicios AUTO-CONTENIDOS siempre.** El niño NO ve el material original (PDF/fotos). Cada enunciado debe
  incluir en su propio texto todos los datos numéricos y la descripción necesaria. Nunca escribas "la figura A" ni
  "según la imagen": si el material se apoyaba en una figura, reescribe el ejercicio con los datos dentro del
  `stem`. Los items no auto-corregibles del material ("dibuja en tu cuaderno", "colorea") conviértelos en
  preguntas equivalentes que SÍ se puedan evaluar con uno de los 7 tipos, o descártalos.
- **Puedes GENERAR FIGURAS, no solo texto.** El modelo tiene un campo opcional `figure` en cada ejercicio: un
  documento **SVG en línea** que se muestra sobre el enunciado. Úsalo cuando una imagen aclare la pregunta
  (geometría: polígonos, triángulos, círculos con radio/diámetro marcados, ejes; diagramas; rectas numéricas;
  fracciones como porciones). Reglas del SVG:
  - Autocontenido: empieza por `<svg ... xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">`, **sin** `<script>`,
    sin `<image>` ni URLs externas, sin fuentes externas. Se renderiza como imagen (data URI), así que cualquier
    script se ignora; mantenlo simple.
  - Legibilidad: se pinta sobre fondo claro. Usa trazos/textos **oscuros** (p. ej. `stroke="#1f2937"`,
    `fill="#1f2937"` para etiquetas) y rellenos suaves; grosor de línea visible (`stroke-width="2"`). Tamaño
    contenido (viewBox ~ 200–360 de ancho; se limita a 240px de alto en la UI).
  - La figura ILUSTRA; la respuesta sigue saliendo del `stem` + los campos del tipo. No metas la solución en la
    figura de forma que se pueda "copiar" trivialmente si no quieres regalarla.
  - Sigue siendo auto-contenido: si pones medidas en la figura, que el enunciado no dependa de ver el PDF original.
- **Alineación con el curso del niño.** `skill.subjectId`/`gradeBand` deben coincidir con un curso que el niño
  tenga asignado, o no lo verá en su galaxia. Consulta el curso del niño destino y usa esos valores exactos
  (en el MVP: `subjectId="math"`, `gradeBand="ESO-5"`).
- El `payload` de D1 lo genera `toStoredPayload()` dentro del endpoint; tú envías el `Exercise` completo (con
  `feedback`) y el servidor lo trocea. No montes el `payload` a mano.

## Vía A — generar desde una descripción (publica GLOBAL en prod)

1. Infiere de la petición: asignatura, nivel, tema/skill, tipos y cantidad. Pregunta SOLO si algo imprescindible
   es ininferible.
2. Redacta tú los ejercicios (`ExerciseSchema`, `ownerId: null`). Comprueba tú la aritmética/los datos: el
   self-check valida coherencia, no la verdad del mundo. Distractores plausibles basados en errores típicos;
   `feedback` con solución trabajada.
3. **Publica en producción** con `POST https://app.smart-kids.uk/api/admin/content/import` (Bearer). El `skillId`
   debe existir en un curso que los niños tengan asignado (asignatura+nivel) para que lo vean. Sin confirmación.
4. Reporta: nº de ejercicios publicados, `skillId`/`packageId`, y a qué curso aplican.

## Vía B — procesar las solicitudes de los tutores (publica PRIVADO en prod)

Autónomo de principio a fin. Para CADA solicitud pendiente:

1. **Lista las pendientes:** `GET https://app.smart-kids.uk/api/admin/content-requests?status=uploaded` (Bearer).
   Cada solicitud trae `ownerId` (tutor), `childId` (destino), `title`, `instructions`, `subjectId`/`gradeBand`
   (pistas, pueden ser null), y su config: `numQuestions` (por defecto 20), `pointsPerCorrect`, `modules`
   (1 = ficha única; >1 = path con N módulos), y sus `assets`.
2. **Descarga los assets si los hay:** `GET .../content-requests/:id/assets/:assetId` (Bearer) devuelve el binario.
   Guárdalo y léelo (el Read tool lee PDFs e imágenes directamente). Una solicitud puede NO tener assets (petición
   solo de texto): entonces genera a partir de `title` + `instructions`.
3. **Comprueba el destino:** confirma que el `childId` pertenece al `ownerId` (o a su hogar) y consulta su curso
   (`subjectId`/`gradeBand`) para alinear el skill. (Puedes leer la D1 de prod con
   `pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --remote --json --command "SELECT ..."`.)
4. **Genera `numQuestions` ejercicios** auto-contenidos, de tipos variados, cubriendo el temario del material.
   **Nombre del skill/path:** usa `title`; si viene vacío O es claramente un placeholder de prueba (p. ej.
   "aaaa", "test", "asdf"), genera tú un nombre corto y claro a partir del contenido/`instructions`.
   **Estructura:** si `modules` = 1, un solo skill; si `modules` > 1, reparte los ejercicios en N skills-módulo que
   forman un **path** (comparten `pathId = path_<requestId>` y el `pathName` que decidas; cada uno con
   `moduleIndex` 0..N-1 y su propio `skill.id`, p. ej. `PRIV.<TEMA>.M1`, `.M2`...).
5. **Publica** cada skill vía `POST https://app.smart-kids.uk/api/admin/content/import` (Bearer), body:
   - `package.ownerId` = `skill.ownerId` = el `ownerId` de la solicitud (privado del hogar).
   - `skill.coinsPerCorrect` = `pointsPerCorrect` de la solicitud.
   - `skill.subjectId`/`gradeBand` = los del curso del niño.
   - Para un path: `skill.pathId`, `skill.pathName` y `skill.moduleIndex` en cada módulo.
   - `assign.childIds` = `[childId]` de la solicitud.
   - `requestId` = id de la solicitud **solo en la ÚLTIMA llamada** (marca `published` y envía UN email al tutor).
   - Cada `exercise` lleva sus campos base (`exerciseId`, `packageId`, `skillId`, `language`, `stem`,
     `difficulty`, `type`) + los del tipo + `feedback`. El endpoint valida y responde `{ ok, exercises, assigned }`.
6. Si el import responde `400`, corrige el/los ejercicio(s) señalado(s) y reintenta (no dejes la solicitud a medias).
7. **Verifica en prod** (opcional pero recomendado): la solicitud quedó `status='published'` con `notified_at`, el
   `child_skills` se creó y hay `numQuestions` plantillas. Reporta al usuario: nº generado, nº rechazado y por qué,
   módulos/path, a qué niño se asignó, email enviado.

## Reglas (no las saltes)

- **Siempre producción, sin confirmación.** No preguntes antes de descargar ni de publicar. Actúa de punta a punta.
- **CERO emojis** en el contenido (política del proyecto). Textos en el idioma de la solicitud/spec (por defecto es).
- **Ejercicios auto-contenidos** (el niño no ve el material). No referencies figuras/imágenes externas.
- **Privado = ámbito del hogar:** `ownerId` del tutor de la solicitud y asignación solo a su(s) niño(s).
- Si el endpoint rechaza un ejercicio (`400`), corrígelo o descártalo; no publiques inválidos.
- **Reporta con honestidad:** cuántos se generaron, cuántos se rechazaron y por qué, y el estado final en prod.
