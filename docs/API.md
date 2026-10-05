# API de smartkids

> **Nota:** los endpoints del sistema de contenido están en su propia sección («Sistema de contenido», abajo). Este
> catálogo aún NO incluye `/api/auth/passkey/*`, `/api/push/*`, `/api/child/stats`, `/api/tutor/summary`,
> `/api/tutor/children/:id/*` ni `/api/tutor/spouse/invite|resend`. Para el catálogo vivo, lee las rutas en
> `apps/api/src/index.ts`; la visión de conjunto está en `../CLAUDE.md` §8.

Catálogo de todos los endpoints del Worker (`apps/api/src/index.ts`). Todos cuelgan de `/api/*` y responden JSON.
El cliente de la SPA que los consume está en `apps/web/src/api.ts`.

## Autorización — guards

No hay middleware global: **cada handler llama a su guard a mano** y hace `if (typeof x !== "string") return x;`.

| Guard | Regla | Error |
|---|---|---|
| `requireParent` | hay sesión de tutor/admin (`sk_session`) | 401 |
| `requireAdmin` | sesión + `role = 'admin'` | 401 / 403 |
| `childOrOwner(childId)` | el propio niño (`sk_child`) **o** el tutor con `ownsProfile` | 401 / 403 |
| `ownsProfile(parentId, childId)` | el niño es del tutor o de su cónyuge con vínculo **simétrico** | — |
| `householdIds(parentId)` | `[parentId (+ spouseId si simétrico)]` — base de las consultas «del hogar» | — |

Notas:
- `/api/tutor/*` usan `requireParent` y **no** exigen rol tutor (un admin con sesión también pasa), salvo
  `POST /api/tutor/spouse`, que sí comprueba `role = 'tutor'`.
- `/api/auth/me`, `/api/auth/resend-verification` y `/api/auth/change-password` hacen su propio check 401 en vez de `requireParent`.

## Público (sin sesión)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/health` | `{ ok, service, ts }`. |
| POST | `/api/auth/login` | Login tutor/admin (email+password). Rate-limit por IP y email. Emite `sk_session`. |
| POST | `/api/auth/logout` | Destruye la sesión de tutor. |
| POST | `/api/auth/verify` | Consume token `verify` → `email_verified = true`. |
| POST | `/api/auth/forgot` | Recuperación: manda enlace `reset` (TTL 1h) si el email existe. Respuesta uniforme (no filtra existencia). Rate-limit por IP. |
| POST | `/api/auth/reset` | Consume token `reset`, fija password (mín. 6), marca email verificado, borra sesiones del tutor. |
| POST | `/api/child/login` | Login de niño (`username`+`pin`). Rate-limit por IP y usuario. Emite `sk_child`. Devuelve niño + cursos. |
| POST | `/api/child/logout` | Destruye la sesión de niño. |
| GET | `/api/child/progress` | Solo sesión de niño: por ámbito (`course:<id>`, `skill:<id>`, `path:<id>`) aciertos, tendencia, tiempo medio, avance y nº de pendientes. |
| GET | `/api/child/review?scope=` | Solo sesión de niño: ids del top 10 de ejercicios PENDIENTES del ámbito (los que más falla primero) para «Repasar fallos». Ámbito ajeno = lista vacía. |
| GET | `/api/child/study-docs` | Solo sesión de niño: «Apuntes» que puede ver (METADATOS: tipo, título, enlaces a skill/path/curso, `origin` global o privado). Globales por los cursos del niño; privados con `child_study_docs` y dueño en su hogar. Sin ocultos ni retirados. |
| GET | `/api/child/study-docs/:id` | Solo sesión de niño: el documento ya redactado (`redactStudyDocForChild`: el texto del dictado nunca; sin respuestas si `childAnswers` es falso). 404 si está oculto o retirado, 403 si no es suyo. |
| POST | `/api/child/mascot` | Solo sesión de niño: `{ mascot }` cambia su personaje (avatar y compañero de viaje) (`orbi`, `redpanda`, `fox`, `cat`, `bunny`, `panda`, `penguin`; otro → 400). |

## Sesión de tutor (`requireParent`)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/auth/me` | Tutor + cónyuge + invitaciones de cónyuge (entrante/saliente) + niños del hogar. |
| POST | `/api/auth/resend-verification` | Reenvía el email de verificación (o `{ alreadyVerified: true }`). |
| POST | `/api/auth/change-password` | Cambia password validando la actual (nueva mín. 6). |
| GET | `/api/courses` | Lista todos los cursos. |
| POST | `/api/tutor/spouse` | Invita a un cónyuge/co-tutor (queda pendiente, sin acceso). Rate-limit. Exige `role = 'tutor'`. |
| POST | `/api/tutor/spouse/accept` | Acepta la invitación entrante; escribe el vínculo simétrico con `db.batch` + verificación. |
| POST | `/api/tutor/spouse/reject` | Rechaza la invitación entrante. |
| DELETE | `/api/tutor/spouse` | Desvincula (ambos lados si simétrico) y barre los grants cruzados: `child_rewards`, `child_skills` y `child_study_docs`. |
| POST | `/api/profiles` | Crea un niño (valida `username` con `USERNAME_RE`, PIN 4+), crea wallet, asigna cursos válidos. |
| POST | `/api/profiles/:id/update` | Actualiza niño (nombre/avatar/`mascot`/pin/username). Requiere `ownsProfile`. `mascot` desconocido → 400. |
| DELETE | `/api/profiles/:id` | Borra niño en cascada (`deleteChildCascade`). Requiere `ownsProfile`. |
| POST | `/api/profiles/:id/courses` | Reemplaza el set de cursos del niño. Requiere `ownsProfile`. |
| GET | `/api/tutor/rewards` | Recompensas del hogar con sus `childIds` asignados. |
| POST | `/api/tutor/rewards` | Crea recompensa (`kind`, `period`, `limitCount`/`limitPeriod`) y la asigna a niños válidos. |
| PATCH | `/api/tutor/rewards/:id` | Edita recompensa del hogar. |
| DELETE | `/api/tutor/rewards/:id` | Borra recompensa del hogar en cascada (`deleteRewardCascade`). |
| GET | `/api/tutor/redemptions` | Canjes `pending` de los niños del hogar. |
| POST | `/api/tutor/redemptions/:id/grant` | Marca el canje como `granted`. Exige `ownsProfile` del niño. |
| POST | `/api/tutor/redemptions/:id/reject` | Marca `rejected`; si era `spend` reembolsa los puntos. |

Nota: `/api/tutor/redemptions*` es la funcionalidad más reciente (bandeja de aprobación familiar); puede estar
en el árbol de trabajo sin commitear según el momento.

## Solo admin (`requireAdmin`)

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/admin/tutors` | Da de alta un tutor (password aleatoria) + invitación por email. Idempotente (reinvita si sigue sin verificar). |
| GET | `/api/admin/tutors` | Lista tutores. |
| POST | `/api/admin/tutors/:id/reset-password` | Cierra sesiones del tutor y le manda enlace de reset (TTL 24h). |
| DELETE | `/api/admin/tutors/:id` | Borra tutor; si tiene cónyuge reasigna niños/recompensas a él, si no borra en cascada. |

## Niño o tutor dueño (`childOrOwner`)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/child/me` | Niño logado (con su `mascot`) + balance + cursos + `customContent` (skills privados del hogar asignados; `exercises` cuenta solo vigentes y visibles). |
| GET | `/api/profiles/:id` | Perfil del niño + balance del wallet. |
| GET | `/api/profiles/:id/courses` | Cursos del niño. |
| GET | `/api/skills?profile=&course=` | Skills del curso (join con `skill_progress`). Exige `hasCourse` o 403 `no_course_access`. |
| GET | `/api/session/next?profile=&skill=&exclude=` | Un ejercicio del skill (sin solución, opciones barajadas), elegido al azar con prioridad a lo pendiente (fallado y aún sin acertar en otra tanda) y variedad de tipos; `exclude` = ids ya servidos en la sesión. Incluye `sessionLength` del skill (default 5). `skill` es obligatorio. Valida acceso (403 `no_course_access`). |
| GET | `/api/session/next?profile=&exercise=` | Sirve un ejercicio CONCRETO (sesión de repaso de fallos). Excluye retirados y ocultos. |
| POST | `/api/session/attempt` | `{ profileId, exerciseTemplateId, answer, responseTimeMs?, clientAttemptId? }`. Corrige EN SERVIDOR, actualiza `skill_progress`, otorga los puntos del skill una sola vez por ejercicio (`coin_awards`). Devuelve `correct`, `correctAnswer`, `parts`, `feedback`, `solution`, `theory`, `coinsAwarded`, `balance`, `masteryScore`, `status`. |
| POST | `/api/session/report` | `{ profileId, exerciseTemplateId, reason }` con `reason` = `wrong_answer` \| `unclear` \| `other`. «Esta pregunta está mal»: exige haber intentado el ejercicio (409 `not_attempted`); la respuesta y el veredicto los copia el servidor de `attempts`. Uno por (niño, ejercicio); volver a marcar lo reabre. |
| GET | `/api/rewards` | Niño: recompensas asignadas del hogar con `progress`/`claimable`/`redeemedInWindow`. Tutor: recompensas del hogar. |
| POST | `/api/rewards/:id/redeem` | Canjea recompensa asignada del hogar. `goal` exige puntos ganados (no descuenta); `spend` descuenta el wallet atómicamente. |

## Sistema de contenido

Tutor (`requireParent`; todo se acota al hogar con `householdIds`, 403 `forbidden` si el skill/solicitud no es suyo):

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/tutor/content` | Skills PRIVADOS del hogar: `exercises` (solo plantillas vigentes), `childIds`, `sessionLength`, `requestId` (solicitud de origen, para ofrecer «Regenerar») y `pathId`/`pathName`/`moduleIndex` (para agrupar los paths). |
| POST | `/api/tutor/skills/:skillId/settings` | `{ sessionLength }` (preguntas por misión, acotado 3..30) de un skill privado del hogar. |
| POST | `/api/tutor/skills/:skillId/assign` | `{ childIds }`: reemplaza los niños asignados (solo niños del hogar). |
| GET | `/api/tutor/skills/:skillId/exercises` | Preview e impresión del tutor: ejercicios vigentes CON solución y `canHide`. Skill privado del hogar: incluidos los ocultos. Skill GLOBAL: solo lectura, sin los ocultos, y solo si algún niño del hogar tiene un curso de esa asignatura+nivel (si no, 403). |
| POST | `/api/tutor/exercises/:templateId/hidden` | `{ hidden }`: oculta/muestra un ejercicio al niño. Ocultar cierra sus avisos abiertos. |
| GET | `/api/tutor/reports` | Avisos «esta pregunta está mal» abiertos de los niños del hogar (plantillas vigentes, máx. 50): niño, skill, enunciado, `render`, `given`/`wasCorrect` (su respuesta), `correctAnswer`, `solution`, `reason` y `canHide` (solo contenido privado del hogar). |
| POST | `/api/tutor/reports/:templateId/resolve` | `{ profileId, action }`: `hide` oculta la pregunta y cierra todos sus avisos (403 si es del catálogo global); `dismiss` descarta el aviso de ese niño. |
| DELETE | `/api/tutor/skills/:skillId` | Borra el skill privado en cascada (`deletePrivateSkillCascade`). |
| GET | `/api/tutor/content-requests` | Solicitudes del hogar con su estado, config y `assets`. |
| POST | `/api/tutor/content-requests` | Multipart: `title?`, `instructions?`, `childId?`, `subjectId?`, `gradeBand?`, `files` (máx. 6, 15 MB, imagen/PDF/texto) y config: `numQuestions` (5..200), `sessionLength` (3..30), `modules` (1..6), `pointsPerCorrect` (1..50), `questionTypes` (lista separada por comas de los 10 tipos; vacío = variados; desconocidos se descartan), `examples` (ejemplos o guía de los ejercicios, texto libre, se recorta a 4000 caracteres; modelo para parte del banco, no lo limita), `outputs` (qué generar, separado por comas: `exercises` y/o tipos de documento; por defecto `exercises,summary,cheatsheet`; vacío → 400 `empty_outputs`). Basta con fichero, `instructions`, `examples` o `title` (si no, 400 `empty_request`). Crea la solicitud `uploaded` y avisa a los admins (push + email). |
| POST | `/api/tutor/content-requests/:id` | Edita una solicitud AÚN `uploaded` (mismos campos; añade ficheros). 409 `not_editable` si ya se procesó. |
| DELETE | `/api/tutor/content-requests/:id` | Borra la solicitud y sus ficheros de R2 que ya nadie referencia. No borra lo publicado. |
| DELETE | `/api/tutor/content-requests/:id/assets/:assetId` | Quita un fichero de una solicitud `uploaded` (R2 solo si nadie más lo referencia). |
| GET | `/api/tutor/study-docs` | Documentos PRIVADOS del hogar (metadatos) con sus `childIds`. |
| GET | `/api/tutor/study-docs/:id` | El documento completo (`body`) con `global`, `canEdit` y `childIds`. Un global, solo si un curso del hogar lo cubre (si no, 403). |
| POST | `/api/tutor/study-docs/:id/assign` | `{ childIds }`: reemplaza los niños asignados (solo del hogar; solo documentos privados). |
| POST | `/api/tutor/study-docs/:id/settings` | `{ hidden?, childAnswers? }`: ocultarlo a los niños y si ven las respuestas en la app (solo privados; republicar no lo pisa). |
| DELETE | `/api/tutor/study-docs/:id` | Borra un documento privado del hogar (y sus asignaciones). |
| GET | `/api/tutor/children/:id/study-docs` | Lo que ve ese niño en «Apuntes» (metadatos). Requiere `ownsProfile`. |
| GET | `/api/tutor/children/:id/pending?scope=&limit=` | Fallos PENDIENTES del niño para imprimir el repaso. Sin `scope`: los ámbitos (`course:`/`skill:`/`path:`) con etiqueta, pendientes, aciertos y tendencia. Con `scope`: además `items` = ejercicios completos (con solución, sin ocultos ni retirados) y `fails` (veces fallado), los que más falla primero (`limit` 1..50, 30 por defecto). Requiere `ownsProfile`. |
| GET | `/api/tutor/courses/:courseId/content?childId=` | Curso del CATÁLOGO para imprimir: sus módulos con nº de ejercicios visibles y sus documentos globales. Solo si un niño del hogar tiene ese curso (con `childId`, ese niño). |
| POST | `/api/tutor/content-requests/:id/regenerate` | Multipart. Solo si está `published` o `failed` (si no, 409 `not_processed`). Relanza la generación sin volver a subir el material; admite cambiar título/instrucciones/ejemplos/niño/config y AÑADIR ficheros (lo que no venga se conserva). `mode=replace` (defecto) reabre la MISMA solicitud (vuelve a `uploaded`, conserva `skill_id`/`package_id`) y se republica sobre los MISMOS skills; si cambia el niño, el anterior pierde ya la asignación a esos skills (conserva su historial); `mode=copy` crea una solicitud nueva (`source_request_id`) que comparte los objetos de R2. Devuelve `{ requestId, mode }`. |

Máquina (skill/pipeline: Bearer `CONTENT_IMPORT_TOKEN` **o** sesión de admin):

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/admin/content-requests?status=` | Solicitudes con `assets` y, por solicitud, `targetExercises` (`ceil(numQuestions * 1.5)`: lo que hay que GENERAR), `regenerate` (bool) y `previousSkills` (en una regeneración en sitio: `id`, `nameI18n`, `pathId`, `pathName`, `moduleIndex`, `sessionLength`, `packageIds` vigentes, `exercises`), `outputs` (qué hay que generar), `docKinds` (los documentos de esa lista) y `previousDocs` (documentos de la publicación anterior: `id`, `kind`, `title`, `skillId`, `pathId`, `moduleIndex`, `version`). `targetExercises` es 0 si no se piden ejercicios. |
| GET | `/api/admin/content-requests/:id/assets/:assetId` | Descarga el binario del fichero desde R2. |
| POST | `/api/admin/content/import` | Publica un lote: `subject?`, `skill?` (UPSERT: si ya existe se actualizan nombre, asignatura, nivel, `coinsPerCorrect`, `pathId`/`pathName`/`moduleIndex` y `sessionLength` si viene), `package`, `exercises` (validados con `ExerciseSchema` + `validateExercise`), `assign?`, `requestId?`, `offset?` (publicación TROCEADA; solo el lote 0 retira lo anterior; ids `<paquete>_<offset+n>`), `replaceSkillContent?` (regeneración en sitio: retira todo lo vigente del skill), `retireSkillIds?` (solo en la llamada que cierra una regeneración; el servidor solo borra los de esa solicitud y nunca el actual). UPSERT por id en `db.batch` de 50. Con `requestId` enlaza el skill a la solicitud y la cierra (`closeRequest`: `published`, `exerciseCount` = total vigente de todos los módulos, `docCount`, `note` con lo pedido que falte, email y push al tutor), salvo con `close: false` (vienen documentos detrás). |
| POST | `/api/admin/study-docs/import` | Publica UN documento de estudio: `doc` = `{ id, ownerId (null = global), subjectId, gradeBand, skillId?, pathId?, courseId?, moduleIndex?, position?, childAnswers?, body }` (`StudyDocMetaSchema` + `StudyDocSchema` + `validateStudyDoc`), `subject?` (la crea si falta), `assign?` (`childIds` del hogar del dueño; un global no se asigna → 400), `requestId?`, `close?` (con `requestId`, `true` cierra la solicitud), `retireDocIds?` (al cerrar una regeneración: borra documentos sobrantes de ESA solicitud). Upsert por id: la versión solo sube si cambia el contenido; `hidden`/`childAnswers` no se pisan. 400 `invalid_doc` (`detail`, `path`), 413 si la petición pasa de 250.000 caracteres o el documento de 90 KB, 409 `id_conflict` (el id es de otro hogar u otra solicitud), 409 `nothing_published` al cerrar sin nada. Devuelve `{ id, version, changed, bytes, assigned, closed? }`. |
| POST | `/api/admin/content-requests/:id/close` | Cierra una solicitud a mano: `{ status: "published" }` (lo que haya publicado; 409 `nothing_published` si nada; admite `retireDocIds`) o `{ status: "failed", note }` (no se pudo generar: avisa al tutor por email y push). |
| GET | `/api/admin/study-docs?requestId=|ownerId=|courseId=` | Documentos (metadatos, `retired` y `childIds`) para verificar una publicación. Exige uno de los filtros (si no, 400). |

## Fallbacks

| Método | Ruta | Qué hace |
|---|---|---|
| ALL | `/api/*` | 404 `{ error: "not found" }` (cualquier ruta de API no definida). |
| ALL | `*` | `ASSETS.fetch(...)` → sirve la SPA. |

## Códigos de error frecuentes

`401 unauthorized`, `403 forbidden` / `no_course_access`, `404 not_found`, `409 email_taken` / `username_taken` /
`already_linked` / `limit_reached` / `conflict`, `429 rate_limited`, `400 invalid` / `insufficient_funds` /
`goal_not_reached` / `invalid_token`.
