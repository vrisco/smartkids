---
name: smartkids_content
description: "Genera contenido educativo para smartkids (ejercicios de los 10 tipos y documentos de estudio: resúmenes, hojas de trucos, tarjetas, glosarios, ejemplos resueltos, esquemas, líneas del tiempo, comprensión lectora, dictados y redacciones) y lo publica en PRODUCCIÓN de forma autónoma, en dos vías: (A) desde una descripción en lenguaje natural del usuario, y (B) procesando el material que los tutores suben por la app (fotos, PDF, texto). Úsala cuando el usuario pida 'generar contenido', 'crear ejercicios de <asignatura/nivel>', 'hacer un resumen / apuntes / hoja de trucos', o 'procesar las solicitudes de contenido de los tutores'."
---

# /smartkids_content

Generador de contenido de smartkids. Convierte una petición (o el material subido por un tutor) en ejercicios y
**documentos de estudio** («Apuntes»: el niño los lee en la app y el tutor los imprime) y los publica en la D1 de
**producción**, listos para usar.

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
- **Token de máquina:** léelo de `apps/api/.dev.vars` (`CONTENT_IMPORT_TOKEN=...`). Ese token **debe coincidir con
  el secreto `CONTENT_IMPORT_TOKEN` de producción** para que los endpoints `/api/admin/content-requests*` e
  `/api/admin/content/import` lo acepten como `Authorization: Bearer <token>`. Si el import responde `401`/`403`,
  el token local NO coincide con el de prod: para y avisa al usuario (hay que sincronizarlos con
  `wrangler secret put CONTENT_IMPORT_TOKEN`). No escribas el token en ficheros versionados ni lo muestres.
- **No necesitas `ANTHROPIC_API_KEY` ni el pipeline `content-gen`.** En la Vía B eres TÚ quien lee el material y
  redacta los ejercicios directamente. El endpoint `/api/admin/content/import` valida cada ejercicio en servidor
  (`ExerciseSchema` + `validateExercise`) y rechaza el lote entero con `400` si alguno es inválido: esa es tu red
  de seguridad. Para lotes grandes, pre-valida además en local con esos MISMOS esquemas (ver «Pre-validación
  local», más abajo) para no gastar llamadas de prod en `400`s; no es obligatorio, pero ahorra viajes.
- La única razón para **parar y preguntar** es que falte un dato imprescindible que no puedas inferir de la
  solicitud ni del material (p. ej. la Vía A con una descripción demasiado vaga). En la Vía B no preguntes: toda
  la config viene en la solicitud.

### Requisitos del entorno (se configuran UNA vez; sin ellos el skill no puede ir solo)

El harness bloquea por seguridad el acceso a producción y la auto-edición de permisos, así que estos dos ajustes
los deja el usuario una sola vez. Si al ejecutar te sale un prompt de permiso o un bloqueo del clasificador tocando
`https://app.smart-kids.uk`, es que falta esto:

1. **Permiso de red a producción.** Debe existir en `.claude/settings.local.json` una regla que permita las
   llamadas de máquina, p. ej. `"Bash(curl:*)"` en `permissions.allow`. (El propio skill no puede añadirla: el
   clasificador bloquea que se auto-conceda permisos.)
2. **Token de prod sincronizado.** El `CONTENT_IMPORT_TOKEN` de `apps/api/.dev.vars` debe ser el MISMO que el
   secreto de producción (`wrangler secret put CONTENT_IMPORT_TOKEN`). Si no coinciden, todo import da `401`/`403`.

Con esos dos en su sitio, el ciclo completo (listar → descargar → generar → publicar) corre sin más intervención.

## Contexto imprescindible

- El modelo del ejercicio es ÚNICO y vive en `packages/shared` (`ExerciseSchema`, 10 tipos: `multiple_choice`,
  `multiple_select`, `numeric`, `fill_in_blank`, `true_false`, `ordering`, `matching`, `step_problem`,
  `column_operation`, `prime_factorization`). NO inventes
  otro formato. Reglas de forma (mín. opciones, ids únicos, `correctOrder` permutación, `correctPairs` bijección,
  huecos `{{1}}`, etc.) y el self-check están en `packages/shared/src/grading.ts` (`validateExercise`).
- **`multiple_select` ("casillas": marca TODAS las correctas):** `options: [{id, text, isCorrect}]` con 4-6
  opciones, **al menos 2 correctas y al menos 1 incorrecta** (todas correctas = inválido). Se acierta solo con el
  conjunto exacto. El `stem` debe dejar claro que puede haber varias ("Marca todas las que...").
- **Cuentas en columna y factorización en primos (matemáticas, «como en el cuaderno»).** Solo llevan los NÚMEROS;
  la solución la calcula la app (`packages/shared/src/arith.ts`), así que no escribas resultados ni factores.
  - `column_operation`: `operation` = `add` | `subtract` | `multiply` | `divide` y `operands` (números JSON >= 0,
    hasta 4 decimales: `40417.84`). Suma 2-4 sumandos; resta, multiplicación y división exactamente 2 (minuendo >=
    sustraendo; el 2º factor, el de abajo, de 1 a 4 cifras). División: `decimals` = decimales del cociente (se
    trunca); sin `decimals` es división ENTERA con resto y entonces dividendo y divisor deben ser enteros. El niño
    la hace en una cuadrícula (llevadas, productos parciales y restos son borrador) y se corrige el resultado (y el
    resto). `stem` corto: "Calcula: 386 × 412", "Divide 40417,84 entre 352 sacando dos decimales".
  - `prime_factorization`: `number` entero 2..9999999. El niño hace la escalera (número | primo) y escribe el
    producto de potencias; vale cualquier orden. `stem`: "Descompón en factores primos: 1428".
  - Úsalos cuando el tema sea cálculo en columna, decimales o divisibilidad (Primaria y 1º-2º ESO); si el material
    del tutor trae cuentas o «factoriza» en su cuaderno, son el tipo natural. `feedback.theory` igual de obligatorio.
- **Feedback COMPLETO en cada ejercicio (el niño lo ve al fallar):** `feedback.correct` e `incorrect` breves,
  `feedback.solution` (cómo se resuelve, paso a paso y corto) y **`feedback.theory`** (1-2 frases con la regla o el
  concepto que hay que recordar, p. ej. "Para sumar fracciones con distinto denominador, primero se pasan a común
  denominador."). Al fallar, la app enseña la respuesta buena + la teoría + la solución: sin `theory` el niño solo ve
  un "casi". `hints` (1-3 pistas de lo general a lo concreto) siguen siendo opcionales y recomendables.
- **Convención de nombres:** `packageId = pkg_{subject}_{gradeband}_{tema}_v{n}`; `skillId` estable y semántico.
  Contenido **global** (Vía A) = `ownerId: null` (catálogo, visible por curso), `skillId` tipo `MATH.ESO5.FRAC.MUL`.
  Contenido **privado del hogar** (Vía B) = `ownerId: <id del tutor>` + asignado a niños concretos, `skillId` tipo
  `PRIV.<TEMA>.<idCortoDeLaSolicitud>` (y `.M1`, `.M2`... si es un path).
- **Ejercicios AUTO-CONTENIDOS siempre.** El niño NO ve el material original (PDF/fotos). Cada enunciado debe
  incluir en su propio texto todos los datos numéricos y la descripción necesaria. Nunca escribas "la figura A" ni
  "según la imagen": si el material se apoyaba en una figura, reescribe el ejercicio con los datos dentro del
  `stem`. Los items no auto-corregibles del material ("dibuja en tu cuaderno", "colorea") conviértelos en
  preguntas equivalentes que SÍ se puedan evaluar con uno de los tipos del modelo, o descártalos.
- **Puedes GENERAR FIGURAS, no solo texto.** El modelo tiene un campo opcional `figure` en cada ejercicio: un
  documento **SVG en línea** que se muestra sobre el enunciado. Úsalo cuando una imagen aclare la pregunta
  (geometría: polígonos, triángulos, círculos con radio/diámetro marcados, ejes; diagramas; rectas numéricas;
  fracciones como porciones). Reglas del SVG:
  - Autocontenido: empieza por `<svg ... xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">`, **sin** `<script>`,
    sin `<image>`, `<foreignObject>`, `<use>` ni URLs externas, sin fuentes externas, sin `on*` ni `style` con
    `url()`. La app **sanea** el SVG (allowlist de elementos/atributos) y lo pinta inline; mantenlo simple.
  - **Color por `currentColor` (theme-aware).** La figura hereda el color del tema, así que **NO** uses colores
    fijos (nada de `#1f2937`, `#000`, etc.): usa `stroke="currentColor"` y `fill="currentColor"`. Para rellenos
    suaves, `fill="currentColor"` con `fill-opacity="0.12"` (o `fill="none"`). Textos/etiquetas con
    `fill="currentColor"`. Grosor de línea visible (`stroke-width="2"`). Así se ve bien en claro y en oscuro.
  - Tamaño contenido (viewBox ~ 200–360 de ancho; en la UI se limita a 320px de ancho / 240px de alto).
  - La figura ILUSTRA; la respuesta sigue saliendo del `stem` + los campos del tipo. No metas la solución en la
    figura de forma que se pueda "copiar" trivialmente si no quieres regalarla.
  - Sigue siendo auto-contenido: si pones medidas en la figura, que el enunciado no dependa de ver el PDF original.
- **Nivel = curso escolar (LOMLOE).** Códigos `PRI-1`..`PRI-6` (Primaria), `ESO-1`..`ESO-4`, `BACH-1`/`BACH-2`.
  Cada niño tiene el suyo y cada solicitud trae el **nivel del contenido** (por defecto el del niño; el tutor puede
  bajarlo para repasar o subirlo para adelantar). Genera para ESE nivel: temario de ese curso (no uses lo que aún no
  se ha dado: nada de negativos en 3º de Primaria ni de ecuaciones de 2º grado en 1º ESO), vocabulario y longitud
  de enunciado acordes a la edad, tamaño de los números y nº de pasos. Cualquier otro valor (p. ej. el antiguo
  `ESO-5`) significa «sin definir»: deduce el nivel del material y las instrucciones.
- El `payload` de D1 lo genera `toStoredPayload()` dentro del endpoint; tú envías el `Exercise` completo (con
  `feedback`) y el servidor lo trocea. No montes el `payload` a mano.
- **Documentos de estudio = JSON por bloques**, también ÚNICO y en `packages/shared` (`src/studydoc.ts`:
  `StudyDocSchema`, `StudyDocMetaSchema`, `validateStudyDoc`, `lintStudyDoc`; catálogo de tipos y materias en
  `src/catalog.ts`). El mismo JSON se pinta en pantalla y en papel: NO escribas Markdown ni HTML. Las plantillas
  de cada tipo están en `packages/shared/test/fixtures/studydocs/*.json` (una por tipo, repartidas entre materias):
  léelas antes de escribir el primero de un tipo. Ver «Documentos de estudio», más abajo.

## Vía A — generar desde una descripción (publica GLOBAL en prod)

1. Infiere de la petición: asignatura, nivel, tema/skill, tipos y cantidad. Pregunta SOLO si algo imprescindible
   es ininferible.
2. Redacta tú los ejercicios (`ExerciseSchema`, `ownerId: null`). Comprueba tú la aritmética/los datos: el
   self-check valida coherencia, no la verdad del mundo. Distractores plausibles basados en errores típicos;
   `feedback` con solución trabajada.
3. **Publica en producción** con `POST https://app.smart-kids.uk/api/admin/content/import` (Bearer). El `skillId`
   debe existir en un curso que los niños tengan asignado (asignatura+nivel) para que lo vean. Sin confirmación.
4. **Documentos (si los pide o encajan):** `POST .../api/admin/study-docs/import`, uno por llamada, con
   `ownerId: null`, `subjectId`+`gradeBand` del curso (los ve todo niño con un curso de esa asignatura y nivel) y
   `skillId` del módulo al que acompañan; sin `assign` (un global no se asigna). Id: `DOC.<SUBJ>.<GRADE>.<TEMA>.<KIND>`
   (p. ej. `DOC.MATH.PRI6.DIV.SUMMARY`). Si es para un curso FIJO del repo, mejor Vía C: el JSON va a
   `content/<curso>/docs/` y se versiona (ver «Documentos de estudio»).
5. Reporta: nº de ejercicios y documentos publicados, `skillId`/`packageId`/ids de documento, y a qué curso aplican.

## Vía B — procesar las solicitudes de los tutores (publica PRIVADO en prod)

Autónomo de principio a fin. Para CADA solicitud pendiente:

1. **Lista las pendientes:** `GET https://app.smart-kids.uk/api/admin/content-requests?status=uploaded` (Bearer).
   Cada solicitud trae `ownerId` (tutor), `childId` (destino), `title`, `instructions`, `subjectId` (pista, puede
   ser null), **`gradeBand` = nivel del contenido** (curso escolar; null = sin indicar), **`child`** =
   `{ gradeBand, courses }` (curso escolar del niño y sus cursos asignados, sin datos personales), sus `assets`,
   y su config:
   - **`outputs`** = qué hay que generar: `"exercises"` y/o tipos de documento (`summary`, `cheatsheet`,
     `flashcards`, `glossary`, `worked_examples`, `concept_map`, `timeline`, `reading`, `dictation`, `writing`).
     Por defecto `["exercises","summary","cheatsheet"]`; las solicitudes antiguas, `["exercises"]`. **`docKinds`** =
     los documentos de esa lista (lo que va al paso 5b). Una solicitud puede pedir SOLO documentos.
   - `numQuestions`: lo que pidió el tutor. **`targetExercises`** = lo que hay que GENERAR (`ceil(numQuestions*1.5)`):
     se genera un 50 % más para que cada tanda del curso salga distinta. Genera `targetExercises`, no `numQuestions`.
     Es `0` si `outputs` no incluye `"exercises"`: entonces sáltate los pasos 4 y 5 y ve directo al 5b.
   - `questionTypes`: tipos pedidos (p. ej. `["numeric","multiple_select"]`); `null` = elige tú la mezcla que mejor
     encaje con la materia y el material.
   - `examples`: **ejemplos o guía** que escribió el tutor (texto libre; `""` = ninguno): ejercicios como los que
     quiere y/o cómo deben ser. Es un MODELO para parte del banco, NO un límite (ver paso 4).
   - `sessionLength`: preguntas por misión (va en `skill.sessionLength` al publicar); `pointsPerCorrect`;
     `modules` (1 = ficha única; >1 = path con N módulos).
   - `regenerate` + `previousSkills` + `previousDocs`: si `regenerate` es `true`, es una **regeneración EN SITIO**
     de algo ya publicado (ver «Regeneración», más abajo). `sourceRequestId` no nulo = copia regenerada de otra solicitud:
     se procesa como una solicitud normal (sus `assets` son los del original).
2. **Descarga los assets si los hay:** `GET .../content-requests/:id/assets/:assetId` (Bearer) devuelve el binario.
   Guárdalo y léelo (el Read tool lee PDFs e imágenes directamente). Una solicitud puede NO tener assets (petición
   solo de texto): entonces genera a partir de `title` + `instructions` + `examples`.
3. **Fija el nivel y la asignatura (sin leer la D1):**
   - **Nivel** = `gradeBand` de la solicitud; si es null, `child.gradeBand`; si también, dedúcelo del material.
     Todo el lote se genera para ese curso (ver «Nivel = curso escolar» en «Contexto imprescindible»).
   - **Metadatos del skill:** `skill.gradeBand` = ese nivel. `skill.subjectId` = el de un curso de `child.courses`
     de la misma materia si lo hay (si además coincide el nivel, el skill sale TAMBIÉN en la galaxia de ese
     curso); si no, el id de la materia (`math`, `lengua`, `ingles`...) y, si puede no existir en `subjects`,
     manda también `subject: { id, nameI18n }` en el import (se crea si falta). El contenido privado se ve
     SIEMPRE en «Fichas» del niño gracias a `assign.childIds`, coincida o no con un curso.
4. **Genera `targetExercises` ejercicios** auto-contenidos cubriendo el temario del material:
   - **Tipos:** reparte entre los de `questionTypes` (si es `null`, mezcla los que encajen con la materia) de forma
     equilibrada, sin que ningún tipo pase del ~40 % salvo que solo se haya pedido uno o dos.
   - **Variedad real, no clones:** con bancos grandes (50-300) recorre TODOS los subtemas del material, cambia
     datos, contextos y formulaciones; evita ejercicios que solo difieran en un número. Dificultad escalonada
     (aprox. 30 % easy, 50 % medium, 20 % hard) con `difficulty.numeric` coherente.
   - **Ejemplos del tutor (`examples` no vacío), sin detrimento del resto:** aprox. **40-60 %** del banco sigue esos
     ejemplos (mismo tipo de tarea, formato, dificultad y estilo de enunciado, con datos, contextos y formulaciones
     NUEVOS; no copies los ejemplos tal cual salvo uno o dos como mucho). El otro 40-60 % sigue cubriendo el resto
     del material y de los subtemas con otros enfoques. El reparto por tipos de `questionTypes` se mantiene en TODO
     el banco: un ejemplo escrito en texto libre se traslada al tipo que mejor lo evalúe (p. ej. «Calcula 3/4 + 1/6»
     → `numeric` o `fill_in_blank`), y ningún tipo pasa del ~40 % por culpa de los ejemplos. Si `examples` es una
     GUÍA (cómo deben ser: «problemas cortos de la vida diaria», «sin decimales», «enunciados de una línea»), aplícala
     a TODO el banco salvo que choque con un tipo pedido, y entonces manda el tipo. Si los ejemplos contradicen el
     nivel del contenido, manda el ejemplo (es lo que el tutor ve en clase). Datos personales que aparezcan en los
     ejemplos (nombres de compañeros, del colegio) no se copian.
   - Cada ejercicio con su `feedback` completo (incluida `theory`, ver «Contexto imprescindible»).
   **Nombre del skill/path:** usa `title`; si viene vacío O es claramente un placeholder de prueba (p. ej.
   "aaaa", "test", "asdf"), genera tú un nombre corto y claro a partir del contenido/`instructions`.
   **Estructura:** si `modules` = 1, un solo skill; si `modules` > 1, reparte los ejercicios en N skills-módulo que
   forman un **path** (comparten `pathId = path_<requestId>` y el `pathName` que decidas; cada uno con
   `moduleIndex` 0..N-1 y su propio `skill.id`, p. ej. `PRIV.<TEMA>.M1`, `.M2`...).
5. **Publica** cada skill vía `POST https://app.smart-kids.uk/api/admin/content/import` (Bearer), body:
   - `package.ownerId` = `skill.ownerId` = el `ownerId` de la solicitud (privado del hogar).
   - `skill.coinsPerCorrect` = `pointsPerCorrect` de la solicitud; `skill.sessionLength` = `sessionLength`.
   - **Lotes de 50 como máximo** (el Worker va en plan Free: 10 ms de CPU por petición). Un skill con más
     ejercicios se publica en VARIAS llamadas al MISMO `package.id` con `offset` = posición del primer ejercicio
     del lote (0, 50, 100...). Solo el lote con `offset: 0` retira lo anterior del paquete; los siguientes añaden.
   - `skill.subjectId`/`gradeBand` = los fijados en el paso 3.
   - Para un path: `skill.pathId`, `skill.pathName` y `skill.moduleIndex` en cada módulo.
   - `assign.childIds` = `[childId]` de la solicitud.
   - `requestId` = id de la solicitud, en la llamada que CIERRA (el ÚLTIMO lote del último módulo; si solo hay una
     llamada, esa):
     marca la solicitud `published`, fija `skillId`/`packageId`/`exerciseCount` y envía UN email al tutor. El cierre
     SOLO ocurre si `requestId` viaja DENTRO del body del import (no basta con tenerlo generado a un lado).
     **Trampa de `modules` = 1:** como solo hay UNA llamada, ESA debe llevar `requestId`; si se olvida, el contenido
     se publica y se asigna, pero la solicitud se queda en `uploaded` y NO se envía el email.
   - **Si `docKinds` no está vacío**, ese último lote lleva `requestId` **y `close: false`**: enlaza los skills a la
     solicitud sin cerrarla (el cierre lo hará el último documento, paso 5b). Sin `close: false` se cerraría ya y el
     email saldría sin los documentos.
   - Cada `exercise` lleva sus campos base (`exerciseId`, `packageId`, `skillId`, `language`, `stem`,
     `difficulty`, `type`) + los del tipo + `feedback`. El endpoint valida y responde `{ ok, exercises, assigned }`.
6. Si el import responde `400`, trae `{ error, detail }` con el mensaje del **primer** ejercicio inválido (sin
   índice); como cada lote es de un módulo (pocos ejercicios), localízalo, corrígelo o descártalo y reenvía. El
   import es **idempotente** (upsert del skill, **UPSERT por id** de plantillas —nunca DELETE: `attempts` y
   `coin_awards` las referencian con FK—, retirada lógica con `retired=1` de lo que no viene en el lote, asignación con
   `onConflictDoNothing`): reenviar el MISMO body NO duplica nada. Úsalo también para auto-repararte: si una
   solicitud publicó el contenido pero se quedó en `uploaded` (te faltó el `requestId`), reenvía el mismo body
   con `requestId` y cerrará bien.

5b. **Documentos (si `docKinds` no está vacío):** genera UN documento por cada tipo de `docKinds` a partir del
   MISMO material (si es un path de varios módulos, el resumen y las tarjetas pueden ir uno por módulo; la hoja de
   trucos, una para todo). Publica cada uno con `POST https://app.smart-kids.uk/api/admin/study-docs/import`
   (Bearer), UNO por llamada, con `doc.ownerId` = `ownerId` de la solicitud, `assign.childIds` = `[childId]` y
   `requestId`. El ÚLTIMO lleva además **`close: true`**: cierra la solicitud (cuenta ejercicios y documentos
   vigentes, anota en `note` lo pedido que falte y envía UN email con todo). Formato, ids y consejos por tipo y
   materia en «Documentos de estudio». Si un tipo pedido NO tiene sentido con ese material (p. ej. una línea del
   tiempo de fracciones), no lo fuerces: publica el resto; la nota del cierre lo dirá. Si no puedes generar NADA
   (material ilegible, vacío), cierra con `POST .../api/admin/content-requests/:id/close` y
   `{ "status": "failed", "note": "<por qué, en una frase para el tutor>" }` (avisa al tutor). Si ya publicaste
   ejercicios y fallan los documentos, cierra con `{ "status": "published" }` para que el email salga igual.
7. **Verifica en prod (hazlo siempre):** vuelve a `GET .../content-requests?status=uploaded` y confirma que la
   solicitud YA NO aparece; que quedó `status='published'` con `notified_at`, que el `child_skills` se creó y que
   su `exerciseCount` (total vigente de todos sus módulos) es `targetExercises`. Con documentos, además
   `GET .../api/admin/study-docs?requestId=<id>` (Bearer): uno por tipo pedido, con `childIds` = `[childId]`. Reporta
   al usuario: nº generado, nº rechazado y por qué, reparto por tipos, módulos/path, documentos publicados, a qué
   niño se asignó, email enviado.

### Regeneración (solicitud con `regenerate: true`)

El tutor relanzó la generación de algo ya publicado cambiando la config (sin volver a subir el material). Hay que
**sustituir el contenido en el MISMO sitio** para que el niño lo siga viendo y conserve su progreso:

- `previousSkills` lista lo publicado antes: `id`, `pathId`, `moduleIndex`, `packageIds` vigentes, `exercises`.
- **Reutiliza los ids de skill:** con `modules` = 1, publica sobre el skill de `moduleIndex` 0 (con `pathId`/
  `pathName` a `null`). Con un path, el módulo *i* reutiliza el skill previo de `moduleIndex` *i* (si existe) y los
  módulos que falten se crean nuevos con `pathId = path_<requestId>`.
- **Paquete NUEVO por skill** (sube la versión en el id: `..._v2`, `..._v3`) y `replaceSkillContent: true` en su
  primer lote (`offset: 0`): así se retira TODO lo anterior del skill, venga del paquete que venga.
- En la llamada que CIERRA, añade `retireSkillIds` con los `previousSkills` que ya no uses (p. ej. al pasar de 3
  módulos a 2). El servidor los borra; solo acepta skills de esa solicitud y nunca el que se está publicando.
- Verifica que cada skill reutilizado muestra SOLO lo nuevo (el conteo del tutor cuenta solo lo vigente).
- **Si cambió el niño o el nivel** (`childId`/`gradeBand` distintos de lo publicado): genera para el NUEVO nivel y
  asigna al nuevo niño (`assign.childIds`). No hace falta quitarle nada al anterior: el endpoint de regeneración ya
  le retiró la asignación (de skills Y de documentos), y el import actualiza `subjectId`/`gradeBand` del skill
  reutilizado con lo que envíes.
- **Documentos:** `previousDocs` lista los publicados antes (`id`, `kind`, `skillId`, `moduleIndex`, `version`).
  Republica cada tipo que siga en `docKinds` con el MISMO `id` (el import hace upsert: sube la versión solo si cambia
  el contenido y conserva lo que curó el tutor, «oculto» y «respuestas para el niño»). Los que sobren (un tipo que ya
  no se pide, un módulo que desaparece) van en `retireDocIds` del documento que cierra (`close: true`), o del
  `/close` si no publicas ninguno. Solo se borran documentos de ESA solicitud.

## Documentos de estudio

Lo que el niño ve en «Apuntes» (y en la tira «Apuntes de este tema» del módulo) y el tutor imprime. Un documento =
un tipo (`kind`) + bloques. Plantillas: `packages/shared/test/fixtures/studydocs/<kind>.<materia>.json`.

### Cómo se publica

`POST https://app.smart-kids.uk/api/admin/study-docs/import` (Bearer), UN documento por llamada:

```json
{
  "doc": {
    "id": "doc_summary_87c1c4ab_m1",
    "ownerId": "par_...",                 // null = catálogo global (Vía A)
    "subjectId": "math", "gradeBand": "PRI-5",
    "skillId": "PRIV.MULTDIV.87c1c4ab.M1", // módulo al que acompaña (opcional)
    "pathId": "path_creq_87c1c4ab", "moduleIndex": 0, "position": 0,
    "body": { "kind": "summary", "title": "...", "language": "es", "goals": ["..."], "estimatedMinutes": 15, "blocks": [ ... ] }
  },
  "assign": { "childIds": ["kid_..."] },
  "requestId": "creq_...", "close": false
}
```

- Responde `{ ok, id, version, changed, bytes, assigned, closed? }`. Errores: `400 invalid_doc` con `detail` y `path`
  (el bloque exacto: `body.blocks.4.items.2`), `413` si el cuerpo pasa de 250.000 caracteres o el documento de 90 KB,
  `409 id_conflict` si el id es de otro hogar o de otra solicitud. Es idempotente: reenviar no duplica.
- **Ids:** privados `doc_<kind>_<idCortoDeLaSolicitud>` y `_m<i>` si hay uno por módulo (`doc_flashcards_87c1c4ab_m2`);
  globales `DOC.<SUBJ>.<GRADE>.<TEMA>.<KIND>`. Estables: al regenerar se reutilizan.
- **Dónde lo ve el niño:** con `pathId` sale en el grupo del path; con `skillId` (sin `pathId`), en el de ese
  skill; un documento del path entero lleva `pathId` sin `skillId`. `position` ordena dentro del grupo.
  `subjectId`/`gradeBand`, los mismos que los skills de la solicitud (paso 3).
- `childAnswers` (opcional): si el niño ve las respuestas en la app. Por defecto sí, salvo en `reading`, `dictation`
  y `writing` (ahí las respuestas solo salen en el PDF del tutor). El tutor lo cambia luego; republicar no lo pisa.

### Texto y notación

- `**negrita**` para los términos clave. Las matemáticas, SOLO entre `$...$` (`$3/4 + 1/6$`, `$2^3 \cdot 5$`);
  fuera de `$` el texto es plano (una «/» no es una fracción y las letras no van en cursiva). `\$` = símbolo del
  dólar. `formula.expr` va en notación matemática SIN `$`. En lengua, idiomas y sociales casi nunca hace falta `$`.
- Nada de Markdown (`#`, `-`, `|`) ni HTML: las listas son bloques `list`, las tablas `table`, los títulos `heading`.
- CERO emojis (lo rechaza el validador). Figuras SVG con las mismas reglas que en los ejercicios (`currentColor`,
  sin scripts ni URLs) y `alt` obligatorio.

### Bloques

`heading` (level 1-3) · `paragraph` · `callout` (`remember` «Recuerda», `tip` «Truco», `warning` «Error típico»,
`fact` «¿Sabías que...?»; `text` y/o `items`) · `list` (`ordered`, subitems) · `table` (`header`, `rows`, celdas
vacías = para completar; `headerColumn` para conjugaciones) · `formula` (`expr`, `label`, `vars`, `note`) ·
`definitions` (`term`, `definition`, `example`) · `vocabulary` (`lang`, `term`, `translation`, `phonetics`,
`partOfSpeech`, `example`, `exampleTranslation`) · `worked_example` (`statement`, `steps[{text, work}]`, `answer`,
`check`, `figure`, `operation` = cuenta en columna o factorización que la app pinta RESUELTA) · `figure` (`svg`,
`alt`, `caption`, `size` s/m/l) · `timeline` (`events[{when, sortKey, title, text}]`) · `tree` (`layout` `braces` =
esquema de llaves, `tree`, `mindmap`; `root` con `children`, profundidad máx. 4, máx. 8 hijos) · `flashcards`
(`cards[{front, back, hint}]`, `frontLang`/`backLang`) · `passage` (párrafos separados por línea en blanco,
`numberLines`, `source`) · `questions` (`open` con `answer` y `lines`, `choice` con `correct` = índice, `true_false`,
`fill` con huecos `{{1}}`… y `answers`; SIEMPRE con respuesta, la clave del PDF sale de aquí; ids únicos en el
documento) · `dictation` (`text` SOLO para el adulto, `focus`, `pace`, `lines` de la hoja del niño) ·
`writing_prompt` (`prompt`, `genre`, `minWords`/`maxWords`, `checklist`, `model`) · `rubric` (criterios con 2-4
niveles, los mismos en todos) · `answer_space` (`lines`, `style` lines/grid/blank) · `page_break`.
Documento: `goals` («Al terminar sabrás...», 2-4), `estimatedMinutes`, `print` (`columns` 1/2, `orientation`,
`cardsPerPage`).

### Qué poner en cada tipo (el validador exige los mínimos)

| Tipo | Mínimo | Cómo hacerlo bien |
|---|---|---|
| `summary` | 1 heading y 3 bloques | Un `heading` por apartado, párrafos cortos, un `callout remember` por apartado, tablas/fórmulas/definiciones donde ayuden y al final `questions` «Comprueba lo que sabes» (3-6). 1-3 páginas en Primaria, 2-4 en ESO. |
| `cheatsheet` | 3 bloques | `print.columns: 2`, denso: listas, fórmulas, tablas y `callout` tip/warning; sin párrafos largos. Máx. ~6000 caracteres (1-2 páginas). |
| `flashcards` | 6 tarjetas | 12-40 tarjetas: delante una pregunta o término corto, detrás la respuesta. Idiomas: `frontLang`/`backLang`. |
| `glossary` | 5 entradas | `definitions` con `example`; idiomas, `vocabulary` (fonética IPA desde ESO). Orden alfabético o por apartado. |
| `worked_examples` | 2 ejemplos | 3-8 `worked_example` de dificultad creciente: pasos con `work`, `answer` y `check`. Cuentas: `operation`. |
| `concept_map` | `tree` de 4 nodos | Esquema de llaves (`braces`) para clasificar; `text` breve en las hojas. Si es ancho, `print.orientation: landscape`. |
| `timeline` | 3 eventos | `sortKey` numérico (año; antes de Cristo, negativo), `title` corto y `text` de una frase; párrafo de contexto antes. |
| `reading` | `passage` + preguntas | Texto acorde a la edad (150-400 palabras en Primaria, 400-900 en ESO) y preguntas literales, de inferencia y de opinión (`open` con `lines`, `choice`, `true_false`, `fill`). |
| `dictation` | bloque `dictation` | Texto de 40-120 palabras con `focus` (b/v, tildes, h...), `pace` para el adulto y `lines` (8-14). Puede llevar un `vocabulary` o una tabla con las palabras difíciles. |
| `writing` | `writing_prompt` + `rubric` | Consigna con `genre`, palabras, `checklist` y `model` (texto modelo); `answer_space` de 12-25 renglones y rúbrica de 3-4 criterios. |

### Según la materia

- **Matemáticas:** fórmulas con `vars`, ejemplos resueltos (con `operation` en cálculo en columna o factorización),
  tablas de criterios y `callout warning` con los errores típicos. Todo número u operación entre `$...$`.
- **Lengua:** sin `$`. Reglas de ortografía en tablas, esquemas de llaves (`tree braces`), comprensión lectora,
  dictado con `focus` y redacción con rúbrica.
- **Idiomas:** el contenido en el idioma estudiado y las explicaciones en español en Primaria (en ESO pueden ir en
  el idioma); `vocabulary` y `flashcards` con `frontLang`/`backLang`, tablas de gramática con `headerColumn`.
- **Ciencias naturales:** `figure` SVG sencillas (la célula, el ciclo del agua) con `alt`, árboles de clasificación
  (`tree`) y glosario.
- **Ciencias sociales:** `timeline` con `sortKey`, mapas esquemáticos en SVG, `passage` con `source` para trabajar
  fuentes y tablas comparativas.

### Vía C (cursos fijos del repo)

Los documentos de un curso fijo viven en `content/<curso>/docs/NN-<slug>.<kind>.json` con
`{ "module"?: "<fichero del módulo>", "position"?: n, "childAnswers"?: bool, "id"?: "...", "doc": { ... } }`.
`pnpm --filter @smartkids/content-gen run build:course -- --course content/<curso>` los valida, los mete en el mismo `.sql`
idempotente (la versión solo sube si cambian; los que quites de `docs/` se retiran) y se aplica con
`wrangler d1 execute`. Ejemplos: `content/math-pri6-calculo/docs/`.

## Pre-validación local (opcional; recomendada para lotes grandes)

El servidor valida y es tu red de seguridad, pero rechaza el **lote entero** con `400` si UN solo ejercicio falla
(con bancos de cientos de ejercicios la pre-validación deja de ser opcional en la práctica);
en lotes grandes conviene pre-validar en local con los MISMOS esquemas antes de tocar prod (no gastas viajes). No
hay que instalar nada: Node >= 22 ejecuta TypeScript con `--experimental-strip-types` y `zod` ya vive en
`packages/shared/node_modules`, así que puedes importar los esquemas de verdad (la resolución de `zod` sale de la
ubicación de `exercise.ts`, no de tu script). Usa rutas `file://` absolutas a `packages/shared/src/…`:

```ts
// validate.ts  ·  node --experimental-strip-types validate.ts cuerpo1.json cuerpo2.json ...
import { readFileSync } from "node:fs";
import { ExerciseSchema } from "file:///<repo>/packages/shared/src/exercise.ts";
import { validateExercise } from "file:///<repo>/packages/shared/src/grading.ts";
for (const f of process.argv.slice(2))
  for (const ex of JSON.parse(readFileSync(f, "utf8")).exercises) {
    const p = ExerciseSchema.safeParse(ex);
    if (!p.success) { console.log(f, "zod:", p.error.issues[0]?.message); continue; }
    const v = validateExercise(p.data);
    if (!v.ok) console.log(f, "self-check:", v.reason);
    // extra fill_in_blank: el nº de marcadores {{n}} del stem debe == nº de blanks
    // extra: feedback.theory y feedback.solution presentes (el niño los ve al fallar)
  }
```

Es literalmente lo que corre el endpoint (`ExerciseSchema` + `validateExercise`), así que lo que pase aquí pasa allí.

Para los documentos, lo mismo con `studydoc.ts` (el envoltorio entero: `doc` del body de import):

```ts
// validate-docs.ts  ·  node --experimental-strip-types validate-docs.ts doc1.json doc2.json ...
import { readFileSync } from "node:fs";
import { StudyDocEnvelopeSchema, validateStudyDoc, lintStudyDoc, studyDocBytes } from "file:///<repo>/packages/shared/src/studydoc.ts";
for (const f of process.argv.slice(2)) {
  const p = StudyDocEnvelopeSchema.safeParse(JSON.parse(readFileSync(f, "utf8")).doc);
  if (!p.success) { console.log(f, "zod:", p.error.issues[0]?.message, p.error.issues[0]?.path.join(".")); continue; }
  const v = validateStudyDoc(p.data.body);
  console.log(f, v.ok ? `ok (${studyDocBytes(p.data.body)} bytes)` : `x ${v.reason}`);
  for (const w of lintStudyDoc(p.data.body)) console.log("  aviso:", w); // no bloquean, pero mejóralos
}
```

**Genera con un script, no a mano.** Para decenas de ejercicios, en vez de teclear JSON, escribe un builder pequeño
(Node) con funciones-fábrica por tipo (garantizan ids únicos y campos base bien puestos) que **calcule las respuestas
en código** (resolver la ecuación, `Math.pow`, aritmética de fracciones) y meta `assert()` que replanteen el
resultado. Así el motor verifica la aritmética —el self-check solo comprueba coherencia interna, no la verdad del
mundo— y emites los N cuerpos de import ya bien formados. No olvides poner `requestId` en el body que CIERRA (paso
5/6): es fácil pasarlo como metadato del script y olvidar meterlo en el body que se envía.

## Reglas (no las saltes)

- **Siempre producción, sin confirmación.** No preguntes antes de descargar ni de publicar. Actúa de punta a punta.
- **CERO emojis** en el contenido (política del proyecto). Textos en el idioma de la solicitud/spec (por defecto es).
- **Ejercicios auto-contenidos** (el niño no ve el material). No referencies figuras/imágenes externas.
- **Siempre `feedback.theory` y `feedback.solution`**: es lo que aprende el niño cuando falla.
- **Genera `targetExercises`** (lo pedido + 50 %) y respeta `questionTypes`; publica en lotes de 50 con `offset`.
- **`examples` del tutor = modelo de ~la mitad del banco, nunca su totalidad:** el resto cubre el material con otros
  enfoques y el reparto por tipos se mantiene.
- **Privado = ámbito del hogar:** `ownerId` del tutor de la solicitud y asignación solo a su(s) niño(s).
- **Genera lo que pide `outputs`:** ejercicios y un documento por cada tipo de `docKinds`. Con documentos, el último
  lote de ejercicios lleva `close: false` y el último documento `close: true`; nunca dejes la solicitud en
  `uploaded` (si algo falla, ciérrala con `/close`).
- **Documentos = bloques JSON** del modelo de `studydoc.ts`, con `$...$` solo para matemáticas y `**negrita**`; nada
  de Markdown, HTML ni emojis. Las preguntas de los documentos llevan SIEMPRE su respuesta.
- Si el endpoint rechaza un ejercicio (`400`), corrígelo o descártalo; no publiques inválidos.
- **Reporta con honestidad:** cuántos se generaron, cuántos se rechazaron y por qué, y el estado final en prod.
