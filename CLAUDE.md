# CLAUDE.md — guía para Claude Code

Guía operativa del monorepo **smartkids** («Órbita»). Léela entera antes de tocar código.

Convenciones de escritura de este repo: **todo en español**, **sin emojis** en la UI ni en textos
(preferencia fija del usuario y política del propio proyecto). Mantén esa norma también en la doc.

**Documentación relacionada** (más detalle): `docs/ARCHITECTURE.md` (modelo de datos, jerarquía de
usuarios, economía de recompensas, flujos de auth, pipeline de contenido), `docs/API.md` (catálogo de endpoints
por rol) y **`docs/adr/`** (Architecture Decision Records: el PORQUÉ de las decisiones grandes — modelo unificado
del ejercicio, generación de contenido, contenido privado del hogar, anti-farm atómico, documentos de estudio). Hay
además `CLAUDE.md` anidados en `apps/api/` y `apps/web/` con las convenciones y gotchas de cada subsistema (se
auto-cargan al trabajar en esas carpetas). Skill del proyecto en `.claude/skills/smartkids_content/` (genera
ejercicios y documentos de estudio).

---

## 1. Qué es

Plataforma de ejercicios educativos con recompensas (tipo Smartick), multi-idioma / multi-asignatura /
multi-nivel, con contenido generado por IA. Dirección visual «Órbita»: mundo espacial oscuro, el
progreso como una galaxia de planetas y una mascota-guía (**Orbi**). MVP: **Matemáticas, currículo
español LOMLOE**, varios niveles. Web / PWA. Desplegado en https://app.smart-kids.uk.

**Jerarquía cerrada, sin registro público:** `ADMIN → TUTORES → NIÑOS → CURSOS`.
El admin (bootstrap por CLI) da de alta tutores; los tutores crean niños (login propio usuario+PIN) y les
asignan cursos (asignatura+nivel) y recompensas. Cuenta de tutor = ancla legal (GDPR); los niños no tienen email.

## 2. Estado y roadmap

Hitos M1–M9 hechos (ver `git log`, Conventional Commits en español con etiqueta `— M#`). **M9 = sistema de
contenido**: los tipos de ejercicio (hoy **10**: los 8 de M9 + cuentas en columna y factorización en primos) con modelo unificado en `packages/shared`, motor de
sesión endurecido (grading EN SERVIDOR + anti-farm ATÓMICO + aleatoriedad + repaso obligatorio), **dos vías de
generación** (skill `smartkids_content`) y **contenido privado del hogar** (fichas/paths que el tutor genera para
sus niños). Después, **documentos de estudio y material imprimible**: «Apuntes» del niño (resúmenes, hojas de
trucos, tarjetas, glosarios, esquemas, líneas del tiempo, lecturas, dictados, redacciones) y un constructor de PDF
con formato por materia y edad (fichas, exámenes con versiones A/B, repaso de fallos, cálculo rápido, tarjetas).
Detalle en §8; el PORQUÉ en `docs/adr/`.

Pendiente (no empieces ninguno sin confirmarlo con el usuario):
- Motor pedagógico **FSRS real** (hoy la subida/bajada de `mastery` es heurística en `POST /api/session/attempt`).
- **Generación real con Claude API** requiere `ANTHROPIC_API_KEY` en el entorno (el pipeline ya es spec-driven
  multi-tipo; sin key corre en `--mock`; la Vía B multimodal "que ve" las figuras del PDF también la necesita).
- Cursos fijos de más asignaturas e idiomas (la generación a medida, los Apuntes y la impresión ya distinguen
  matemáticas, lengua, idiomas, naturales y sociales, pero el catálogo global solo tiene matemáticas).

## 3. Arranque y comandos

Requisitos: **Node ≥ 22** y **pnpm 10.32.1** (`corepack enable`). Entorno del usuario: **Windows + PowerShell**.

```bash
pnpm install
pnpm dev            # web (Vite :5173) + api (wrangler dev :8787) en paralelo
```

- Web local: http://localhost:5173 — proxya `/api/*` → Worker local `:8787` (config en `apps/web/vite.config.ts`).
- API local: http://localhost:8787/api/health — corre en el runtime real de Workers (workerd/Miniflare) con
  **D1/KV/R2 locales en `.wrangler/`**. No toca la nube ni cuesta nada.

| Comando (raíz) | Qué hace |
|---|---|
| `pnpm dev` | Levanta web + api en paralelo. |
| `pnpm build` | `pnpm -r run build` (recursivo). |
| `pnpm typecheck` | `tsc --noEmit` en todos los paquetes. **content-gen queda fuera** (no define el script). |
| `pnpm test` | Pruebas de los paquetes que las definen (hoy solo `packages/shared`: grading + corpus de `content/`). |
| `pnpm run deploy:staging` | Despliega al entorno de **pruebas** (`app-staging`, base y bucket propios, sin cron, sin Resend). |
| `pnpm run db:migrate:staging` / `db:seed:staging` | Migra y siembra la D1 de pruebas. El seed **solo** es seguro aquí y en local. |
| `pnpm format` / `pnpm format:check` | Prettier (defaults, sin config propia). |
| `pnpm deploy` | Build de la web **y luego** `wrangler deploy` del Worker. El orden importa. |
| `pnpm db:migrate:remote` | Aplica migraciones a la D1 **de producción**. |

Scripts por paquete (via `pnpm --filter @smartkids/<pkg> run <script>`):
- **api**: `db:generate` (drizzle-kit), `db:migrate` / `db:seed` (**solo `--local`**), `admin` (CLI de admin), `cf-typegen`.
- **content-gen**: `generate` (pipeline de contenido; añade `-- --mock` para modo offline).

**Admin bootstrap** (no hay registro público):
```bash
pnpm --filter @smartkids/api run admin -- create <email> <password> [--remote]
pnpm --filter @smartkids/api run admin -- reset  <email> <password> [--remote]
```
Sin `--remote` opera sobre la D1 local. El admin luego da de alta tutores desde la UI.

## 4. Arquitectura de un vistazo

Monorepo pnpm (`apps/*`, `packages/*`, `tools/*`):

```
apps/web/          SPA React 19 + Vite 6 + PWA  ·  paquete @smartkids/web
apps/api/          Hono en Cloudflare Workers   ·  paquete @smartkids/api
packages/shared/   tipos + esquemas Zod (Zod)   ·  @smartkids/shared  (source-only, sin build)
tools/content-gen/ pipeline offline de contenido ·  @smartkids/content-gen
```

**Un ÚNICO Worker (`name = "app"`) sirve todo en el mismo origen** (sin CORS):
- La API bajo `/api/*` (Hono, `apps/api/src/index.ts`).
- La SPA con Static Assets (`binding = ASSETS`, `directory = ../web/dist`, fallback SPA). Todo lo que no
  sea `/api/*` se delega a `ASSETS.fetch`.
- Datos en **Cloudflare D1** (SQLite, `binding = DB`). También **R2** (`binding = UPLOADS`, bucket
  `smartkids-uploads`) para el material que suben los tutores (Vía B). No hay KV ni Durable Objects: el resto del
  estado (sesiones, rate-limit, tokens) vive en D1.

Consecuencia clave: **el binding `ASSETS` apunta a `apps/web/dist`**. En un clon nuevo o antes del primer
`wrangler dev`/`deploy`, ejecuta `pnpm --filter @smartkids/web run build` o falla.

## 5. Modelo de datos

Drizzle sobre D1/SQLite, **30 tablas**, esquema en `apps/api/src/db/schema.ts`. La frontera está marcada con
comentarios de sección en el propio schema:

- **CONTENIDO (inmutable, versionado):** `subjects`, `skills`, `skill_prerequisites`, `content_packages`,
  `exercise_templates`. IDs semánticos estables (`MATH.ESO5.FRAC.ADD`); versionado por `content_packages.version`
  y `exercise_templates.content_version`. El contenido **nunca se muta in-place**: se publican nuevas versiones.
  `skills`/`content_packages` llevan `owner_id` (null = catálogo GLOBAL; set = **PRIVADO del hogar** del tutor);
  `skills` además `coins_per_correct` (puntos por acierto), `session_length` (preguntas por misión; null = 5) y
  `path_id`/`path_name`/`module_index` (agrupar módulos).
- **DOCUMENTOS DE ESTUDIO:** `study_docs` (el documento entero en `body` JSON, hasta 90 KB; `kind`, `owner_id`
  null = global / tutor = privado, `subject_id`+`grade_band`, enlaces opcionales a `skill_id`/`path_id`/`course_id`/
  `request_id`, `version` que solo sube si cambia `content_hash`, y la curación del tutor `hidden`/`child_answers`) y
  `child_study_docs` (acceso niño↔documento PRIVADO). Ver §8.
- **PROGRESO (mutable, por niño):** `skill_progress`, `attempts`, `coin_awards` (registro ATÓMICO de "ya cobrado"
  por (niño, ejercicio), PK compuesta → anti-farm sin carrera), `exercise_reports` (avisos «esta pregunta está mal»
  del niño, uno por (niño, ejercicio), los revisa el tutor), y la economía `wallets`, `wallet_ledger`,
  `redemptions`. Cada intento congela `content_version` para que el histórico no se corrompa si el contenido evoluciona.
- **Identidad y acceso:** `parent_accounts` (tutores/admin, `role`), `child_profiles`, `courses`,
  `child_courses` (acceso niño↔curso), `child_rewards` (acceso niño↔recompensa), `child_skills`
  (acceso niño↔skill PRIVADO), `rewards`.
- **Contenido a medida (Vía B):** `content_requests` (petición del tutor: material + config + estado;
  `outputs` = qué generar, ejercicios y/o tipos de documento; `doc_count`;
  `source_request_id` = copia regenerada que comparte los ficheros de su origen) y `content_request_assets`
  (metadatos de los ficheros; el binario vive en R2). Ver §8.
- **Seguridad:** `sessions` (tutor), `child_sessions` (niño), `auth_tokens` (verify/reset), `login_attempts` (rate-limit).

**Hogar / cónyuge:** `parent_accounts.spouse_id` + `spouse_pending_from`. Un tutor puede compartir TODOS sus
niños con un co-tutor. **El vínculo solo concede acceso si es SIMÉTRICO** (`A.spouse_id=B` y `B.spouse_id=A`):
`householdIds()` y `ownsProfile()` (en `apps/api/src/index.ts` / `auth.ts`) lo comprueban en ambos lados. Un
estado asimétrico nunca da acceso. La vinculación es con **consentimiento bilateral** (invitar deja pendiente
sin acceso; el invitado acepta/rechaza).

**Economía / recompensas:** `rewards.kind` = `spend` (canjeable: descuenta `wallets.balance` con decremento
atómico condicional) o `goal` (objetivo: exige N puntos GANADOS en ejercicios en una ventana; NO descuenta).
`earnedSince()` suma solo movimientos de `wallet_ledger` con `reason LIKE 'exercise:%'`. Las ventanas
(`period`, `limit_period`) son **rodantes**: `week`=7d, `month`=30d, `quarter`=90d, `semester`=180d, `year`=365d
(desde ahora, no de calendario). Las monedas por acierto salen de `skills.coins_per_correct` (o el global
`COINS_PER_CORRECT=10`) y se conceden **una sola vez por ejercicio de forma atómica** (`coin_awards`).
El `reason` del ledger distingue por prefijo: `exercise:`, `redeem:`, `refund:`.

## 6. Backend (`apps/api`) — lo esencial

Reglas que hay que respetar siempre:

- **No hay middleware global de auth: cada handler llama a los guards a mano.** Patrón repetido:
  el guard devuelve `string` (el id) o un `Response`, y el handler hace `if (typeof x !== "string") return x;`.
  Guards: `requireParent`, `requireAdmin`, `childOrOwner`, y los helpers `ownsProfile` / `householdIds` / `hasCourse`.
  **Al añadir un endpoint nuevo, no olvides el guard** o queda abierto.
- **Sesiones en D1, no JWT.** Cookies `sk_session` (tutor) y `sk_child` (niño), httpOnly, SameSite=Lax,
  `secure` solo en https. En BD se guarda `sha256(token)`, nunca el token en claro. Expiración perezosa.
- **Hashing PBKDF2** (100k iter, SHA-256, salt 16 bytes, formato `salt:hash`) para password de tutor y PIN de niño.
  Comparación en tiempo constante. El **mismo** esquema lo replica `scripts/admin.mjs`.
- **Rate-limiting** en tabla `login_attempts` (6 intentos / 15 min por identificador de IP y de email/usuario).
- **Email por Resend** (`apps/api/src/email.ts`): sin `RESEND_API_KEY` cae a modo mock (`console.log`, no envía).
  Con `EMAIL_DEV_LINKS=true` los endpoints devuelven el enlace de verify/reset/invite en la respuesta HTTP
  (`devLink`) para probar sin proveedor. **`EMAIL_DEV_LINKS` NUNCA debe estar a `true` en producción.**
- **IDs con prefijo por tipo:** `par_` (tutor), `par_admin_` (admin, en la CLI), `kid_` (niño), `rw_` (reward);
  el resto UUID/sha256. Timestamps siempre ISO string. Emails y usernames a `.trim().toLowerCase()`.
- **Sin transacciones reales salvo `db.batch`.** Los borrados en cascada (`deleteChildCascade`,
  `deleteRewardCascade`, borrado de tutor) son secuencias no atómicas: un fallo a mitad deja estado inconsistente.

## 7. Frontend (`apps/web`) — lo esencial

Reglas que hay que respetar siempre:

- **No hay router.** Solo `/`, `/verify` y `/reset` son rutas físicas; el resto es render condicional por
  **rol/estado** en `apps/web/src/App.tsx` (prioridad: sesión de niño > admin > tutor > login). La navegación
  interna (KidApp: `map`/`session`/`reward`) es estado local, no URL-addressable.
- **CERO emojis.** Todo icono es SVG vía `components/Icon.tsx` (unión cerrada `IconName`). No metas emojis.
- **Personaje del niño** (su avatar Y el compañero que le acompaña): `components/Mascot.tsx`, claves `MASCOT_KEYS`
  (`orbi` + animales astronauta: `redpanda`, `fox`, `cat`, `bunny`, `panda`, `penguin`), guardado en
  `child_profiles.mascot`. Lo elige el tutor (ficha del niño) o el niño (pestaña Progreso → `POST /api/child/mascot`).
  `<Mascot />` sin `name` pinta el del niño (`MascotContext`, lo provee `KidApp`); el login muestra el último usado
  en el dispositivo (`sk_mascot`). La lista se repite en la API (`MASCOTS` en `index.ts`): añade claves en los dos.
  Como avatar redondo (barra superior del niño, lista de niños del tutor) se usa `<MascotAvatar>` (busto). La
  columna `child_profiles.avatar` es LEGADO: ya no se pinta ni se edita (los avatares redondos antiguos se retiraron).
- **Tokens de diseño en `styles/tokens.css`.** Usa SOLO variables (`var(--...)`), nunca colores sueltos.
  Botones de **altura uniforme** (`--btn-h`, `--btn-h-sm`); escala de espaciado `--sp-1..--sp-8` para que la UI
  «respire»; breakpoints `760px` y `1080px`. Los valores del **tema oscuro están duplicados** en dos bloques
  (`@media prefers-color-scheme:dark` y `[data-theme="dark"]`): al cambiar la paleta oscura edita los dos.
- **i18n:** `useTranslation()` → `t()` para textos de UI (diccionarios `es`/`en` inline en `src/i18n.ts`;
  TypeScript exige paridad de claves entre idiomas). Para el **contenido multi-idioma del servidor** (`LocaleText`,
  nombres de skill/curso/reward) usa `tx()`, que vive en `src/api.ts` (no en `i18n.ts`). Idioma en `localStorage.sk_lang`.
- **Tema:** `data-theme` en `<html>` + `src/settings.ts` (`getTheme`/`setTheme`/`applyTheme`), persistido en
  `sk_theme`, aplicado antes del primer render en `main.tsx`. El `Starfield` (canvas) no se recolorea al vuelo.
- **Cliente API (`src/api.ts`):** rutas **relativas** `/api/...`, cookies de mismo origen (sin `credentials:"include"`).
  Cualquier despliegue cross-origin rompería la sesión. Errores: cada pantalla hace `try/catch` y muestra `e.message`.
- **Impresión = PDF del navegador** (`window.print()`, sin servidor): todo lo imprimible pasa por
  `components/print/` (`usePrintJob` monta UN nodo `.ws-print-root` directamente bajo `body`, imprime dentro del
  clic y pone un `@page` por trabajo: A4/Carta, número «n / N»). Dentro de `.ws-sheet` y `.sd.paper` los tokens del
  tema se remapean a tinta de papel (`--print-*` de `tokens.css`): sale igual con el tema oscuro. Estilos en
  `styles/print.css` y `styles/studydoc.css`. Para probar: `apps/web/print-demo.html` (solo en desarrollo, no entra
  en `dist/`) y `node apps/web/scripts/print-check.mjs` (genera los PDF con Chrome sin interfaz en `.print-out/`).

## 8. Sistema de contenido (10 tipos + 3 vías de publicación)

**Modelo unificado del ejercicio = fuente ÚNICA de verdad en `packages/shared`** (`src/exercise.ts` esquemas Zod
de los 10 tipos + `src/grading.ts` la lógica). Lo importan la API Y la web (se acabó la divergencia con D1).
- 10 tipos: `multiple_choice`, `multiple_select` («casillas»: marcar TODAS las correctas; `options` min 3, respuesta
  `{ optionIds }`, acierta solo el conjunto EXACTO, marcar de más = fallo), `numeric`, `fill_in_blank` (huecos
  `{{1}}`), `true_false`, `ordering`, `matching`, `step_problem`, `column_operation` y `prime_factorization`.
- **Cuentas «como en el cuaderno»**: `column_operation` (`operation` add/subtract/multiply/divide + `operands`;
  división con `decimals` = decimales del cociente truncado, sin él = entera con resto) y `prime_factorization`
  (`number`). Solo guardan los NÚMEROS: la solución la calcula `src/arith.ts` (aritmética EXACTA con BigInt, división
  «en casita» paso a paso, escalera de factores), así que no se puede publicar una cuenta mal resuelta. El niño la
  hace en una cuadrícula (`apps/web/src/components/ColumnOps.tsx`); solo se corrigen resultado y resto (respuesta
  `{ result, remainder? }`) o el producto de potencias (`{ factors: [{ base, exp }] }`, cualquier orden; vale
  `2 · 2` por `2^2`): llevadas, productos parciales, restos y escalera son borrador. Al fallar se enseña la cuenta
  resuelta; en la ficha PDF salen en cuadrícula/escalera vacías. Topes (cifras, decimales, minuendo >= sustraendo...)
  en `columnSpecProblem`, que aplica `validateExercise`.
- `grade(ex, answer)` corrige EN SERVIDOR; `redactForClient(ex)` quita la solución antes de enviar (el niño NUNCA
  ve la respuesta; en `multiple_select` tampoco cuántas son correctas) y `shuffleRender` baraja la presentación;
  `toStoredPayload()/exerciseFromRow()` mapean a la columna `payload` JSON; `validateExercise()` (self-check: la
  clave marcada corrige acierto; en `multiple_select` exige >=1 correcta, >=1 incorrecta e ids únicos) lo usa el
  pipeline. `feedback` = `correct`/`incorrect` + opcionales `solution` (cómo se resuelve) y `theory` (trocito
  «Recuerda: ...» que se enseña al fallar).
- La web importa SOLO **tipos** de `shared` (`import type` → cero runtime, `zod` no entra en el bundle), con UNA
  excepción: `@smartkids/shared/arith` (subpath export, sin zod), que la web usa en tiempo de ejecución para colocar y
  resolver las cuentas. No importes en runtime desde `@smartkids/shared` a secas: arrastraría zod. En
  `tsconfig.base.json` está `allowImportingTsExtensions` para que el pipeline importe `shared` bajo
  `node --experimental-strip-types` (los imports internos de `shared` llevan extensión `.ts`).

**Progreso del niño y «Repasar fallos»**: cada curso, ficha y path muestra al niño sus aciertos (con tendencia:
últimas 20 respuestas frente a las 20 anteriores), su tiempo por pregunta y su avance (temas dominados o preguntas
hechas), con `GET /api/child/progress` (`progresoDelNino` agrupa por ámbito `course:`/`skill:`/`path:`; el curso
incluye los privados de su asignatura+nivel, igual que su galaxia). «Repasar fallos» (`GET /api/child/review?scope=`)
lanza una tanda con el top 10 de sus PENDIENTES del ámbito, los que más falla primero (`Session` con `reviewIds`
empieza directamente en la fase de repaso). Al corregirlos en otra tanda salen de la lista y el botón desaparece.

**Motor de sesión** (`GET /api/session/next` + `POST /api/session/attempt`, en `apps/api/src/index.ts`): corrige
los 10 tipos en servidor y baraja opciones por servida. `next` carga un banco LIGERO (solo id+tipo, hasta 1000) y
elige de forma ALEATORIA PERO PRIORIZADA, nunca en orden fijo: con probabilidad 0.7 (`PRIORIDAD_FALLOS`) sortea
entre los «pendientes» (fallados y aún sin acertar en OTRA tanda, es decir, más de 20 min después del último fallo:
acertarlo en el repaso de la misma misión no lo salda; más peso cuantos más fallos) y si no entre el resto (fallado alguna
vez 3 > nuevo 2 > siempre acertado 1; lo visto en los 20 últimos pesa x0.15), penalizando repetir tipo en la
sesión. Devuelve además `sessionLength` del skill (preguntas por misión; default 5). `attempt` devuelve `solution`
y `theory`. Las estadísticas (`computeProfileStats`) reconstruyen las sesiones por huecos de 20 min y separan la
primera vuelta (cada ejercicio una vez) del repaso: `failed`/`retried`/`fixed` = falladas, repasadas y corregidas
en la sesión, además de `durationMs` (lo que duró la tanda) y `avgMs` (media por respuesta). Los tiempos de respuesta
se recortan a 5 min (`RT_TOPE_MS`) en medias y en el top `slowest` (preguntas en las que más tarda), que solo se
calcula para el tutor. La web lo pinta en `StatsView`. Al fallar, la web muestra una tarjeta con la respuesta correcta, la teoría («Recuerda») y cómo se
resuelve. Al acabar la tanda, si hubo fallos, pantalla de transición y **SESIÓN DE REPASO** con los MISMOS
ejercicios fallados en orden aleatorio (`?exercise=<id>`; fallar lo manda al final de la cola, tope = fallos + 3)
y un resumen final (lógica en `apps/web/src/screens/Session.tsx`). Tras responder, el niño puede marcar
**«¿Esta pregunta está mal?»** (`POST /api/session/report`: motivo + su última respuesta, que el servidor copia de
`attempts`); el tutor lo ve en su panel (`GET /api/tutor/reports`) y oculta la pregunta (solo contenido privado del
hogar) o descarta el aviso. Si es del catálogo global, el cron diario lo resume al admin. Republicar una plantilla
con otro contenido borra sus avisos (hablaban de la versión anterior). Los inputs de texto de las respuestas van
sin autocorrector ni corrector ortográfico (`NO_AUTOCORRECT` en `ExerciseInput.tsx`). El cuerpo de `attempt` es `{ answer }` (unión
discriminada `AnswerSchema`), con compat del viejo `selectedOptionId`. Inputs de los 10 tipos en
`apps/web/src/components/ExerciseInput.tsx` (las cuentas y la factorización, en `ColumnOps.tsx`).

**Vía A — desde una descripción** (catálogo GLOBAL): `tools/content-gen/src/generate.ts` es spec-driven multi-tipo.
Lee una **spec JSON** (`--spec <ruta>`, ver `spec.example.json`); `--mock` sin coste; real con `ANTHROPIC_API_KEY`
(`claude-opus-4-8`, salida Zod; el prompt y el mock cubren `multiple_select` y piden `feedback.theory`). Valida con
`validateExercise`, escribe `out/<pkg>.json`+`.sql` (**`out/` gitignored**) y se aplica con `wrangler d1 execute`
(a mano; el `.sql` requiere la D1 ya sembrada).

**Vía B — desde material del tutor** (PRIVADO del hogar): el tutor sube fotos/PDF/texto **o solo una descripción**
desde el panel → `POST /api/tutor/content-requests` (multipart, R2) crea una `content_requests` con su config
(`num_questions` 5..200, `session_length` 3..30, `points_per_correct`, `modules` 1..6, `question_types` = lista de
tipos, null = variados; `examples` = ejemplos o guía de los ejercicios que quiere, texto libre hasta 4000
caracteres, que la skill usa de MODELO para ~la mitad del banco sin dejar de cubrir el resto del material ni el reparto
por tipos; título opcional). Al crearla o regenerarla se **avisa a los administradores** (push + email)
de que hay algo por procesar con la skill. Se GENERA un 50 % más de lo pedido (`GENERATION_EXTRA = 1.5`, el listado
de máquina da `targetExercises`) para que cada tanda salga distinta. La skill lista las pendientes, descarga los
assets, genera, y publica vía `POST /api/admin/content/import` (auth: Bearer `CONTENT_IMPORT_TOKEN` **o** sesión de
admin): crea skill PRIVADO (`owner_id`=tutor) + paquete + plantillas, lo asigna al niño (`child_skills`), marca la
solicitud `published` y **envía email al tutor**. `modules>1` genera un **path** de N módulos. Los paquetes grandes
se publican TROCEADOS (`offset`; solo el lote 0 retira lo anterior) y las plantillas se escriben con `db.batch` por
tandas de 50 (plan Free: 1000 subpeticiones y 10 ms de CPU por invocación). Una solicitud aún no procesada (status
`uploaded`) es **editable** (`POST .../content-requests/:id` añade ficheros/campos; `DELETE .../:id/assets/:assetId`
quita uno). Una ya procesada (`published`/`failed`) se **regenera** sin volver a subir el material
(`POST .../content-requests/:id/regenerate`): `mode=replace` reabre la MISMA solicitud y la skill republica sobre los
MISMOS skills (`previousSkills` + `replaceSkillContent`/`retireSkillIds`; el niño conserva asignación y progreso;
si se cambia de niño, el anterior pierde la asignación al regenerar y el nuevo la recibe al republicar; el import
actualiza también asignatura y nivel del skill, por si cambió el curso escolar);
`mode=copy` crea una solicitud nueva (`source_request_id`) que comparte los objetos de R2 del original (por eso
R2 solo se borra cuando ninguna fila lo referencia: `deleteR2IfUnreferenced`). Las preguntas por misión de un
contenido ya publicado se cambian con `POST /api/tutor/skills/:skillId/settings`.

**Vía C — cursos fijos** (catálogo GLOBAL, redactados a mano y VERSIONADOS en el repo): a diferencia de la Vía A
(que genera con IA a `out/` gitignored), estos cursos viven en **`content/<curso>/`** (fuente de verdad EDITABLE, en
git): un `course.json` (metadatos + lista ORDENADA de módulos) y un fichero por módulo (`NN-<slug>.json` con
`{ skill, exercises }`; los ejercicios NO llevan los campos de contexto —`exerciseId`/`packageId`/`skillId`/
`language`—, los inyecta el builder). `tools/content-gen/src/build-course.ts` (script `build:course`) valida cada
ejercicio (`validateExercise` + Zod) y emite UN `.sql` **idempotente** (UPSERT de subject/curso/skills, cadena de
`skill_prerequisites` por orden de módulo, **UPSERT por id** de paquetes/plantillas) en `out/<courseId>.sql`. Se
aplica con `wrangler d1 execute` (local o `--remote`). **Evolucionar** = editar el JSON del módulo y re-ejecutar
(la publicación **NO es destructiva**: hace UPSERT por id y marca `exercise_templates.retired=1` lo que ya no viene
en el lote, porque `attempts` y `coin_awards` las referencian con FK; `hidden` queda fuera del UPDATE para no pisar
la curación del tutor, y si cambia el enunciado o el payload se libera su `coin_awards` para que el niño vuelva a
cobrar por contenido nuevo). El niño ve el curso cuando el tutor se lo **asigna** (asignatura+nivel);
`owner_id` NULL = global. Cursos: `content/math-eso2-operaciones/` (2º ESO, nivel `ESO-2`, 10 módulos, 118
ejercicios) y `content/math-pri6-calculo/` (6º Primaria, `PRI-6`, 5 módulos, 68 ejercicios: sumas y restas,
multiplicaciones, divisiones con resto y con decimales en columna, y descomposición en factores primos). Los módulos
de un curso se desbloquean en orden en la galaxia (según `skill_progress`). Nota: el `gradeBand` del niño es cosmético (HUD), NO filtra contenido: lo entrega el curso asignado.

**Skill del proyecto** `.claude/skills/smartkids_content/SKILL.md`: guía paso a paso de las vías A y B. Invócala con
`/smartkids_content <descripción>` o `/smartkids_content pendientes`. El frontmatter usa `name`+`description` (NO
`trigger`). **OJO discovery**: Claude Code solo escanea `.claude/skills/` de `~/` y de la RAÍZ del workspace, no de
subcarpetas; para verla, abre el workspace EN `smartkids/` (o usa la copia personal `~/.claude/skills/smartkids_content/`).

**Acceso a contenido privado:** un skill privado solo lo ve/juega un niño si su `owner_id` sigue en el HOGAR del
niño **Y** tiene `child_skills` asignado. `childCanAttemptSkill`, `GET /api/skills` y `GET /api/child/me` revalidan
el hogar (el grant `child_skills` NO basta). Al desvincular cónyuge (`DELETE /api/tutor/spouse`) se limpian los
grants cruzados de recompensas, de skills Y de documentos.

### Documentos de estudio («Apuntes») y material imprimible

**Modelo** en `packages/shared/src/studydoc.ts` (Zod; el PORQUÉ en `docs/adr/0005-documentos-de-estudio.md`): un
documento es `{ kind, title, language, goals?, estimatedMinutes?, print?, blocks }` con **10 tipos** (`summary`,
`cheatsheet`, `flashcards`, `glossary`, `worked_examples`, `concept_map`, `timeline`, `reading`, `dictation`,
`writing`) y **20 tipos de bloque** (títulos, párrafos, «Recuerda»/«Truco»/«Error típico», listas, tablas, fórmulas,
definiciones, vocabulario, ejemplos resueltos con cuenta en columna, figuras SVG, líneas del tiempo, esquemas de
llaves, tarjetas, textos de lectura, preguntas con respuesta, dictado, consigna de redacción, rúbrica, espacio para
escribir, salto de página). El MISMO JSON se pinta en pantalla y en papel. Texto: `**negrita**` y matemáticas SOLO
entre `$...$` (`components/Txt.tsx`); nada de Markdown ni HTML. `validateStudyDoc()` (emojis, `$`/`**`
equilibrados, SVG seguro, límites, ids de pregunta, mínimos por tipo, 90 KB) lo usan el import y el builder;
`lintStudyDoc()` solo avisa. `redactStudyDocForChild()`: el texto del **dictado nunca llega al niño** y las
respuestas se quitan si `child_answers` es falso (por defecto falso en lectura, dictado y redacción). Catálogo
(tipos, materias y su familia, salidas por defecto) en `src/catalog.ts`, sin zod: la web lo importa en runtime vía
`@smartkids/shared/catalog`. Plantillas de cada tipo en `packages/shared/test/fixtures/studydocs/`.

**Visibilidad:** un documento GLOBAL (`owner_id` NULL) lo ve el niño con un curso de esa asignatura+nivel; uno
PRIVADO, si tiene `child_study_docs` y el dueño sigue en su hogar (`childCanReadDoc`, como los skills). Ocultos
(`hidden`) y retirados no salen. El tutor ve los globales de los cursos de su hogar en solo lectura.

**Publicación:** Vía B y A con `POST /api/admin/study-docs/import` (Bearer, un documento por llamada, upsert por id;
la versión solo sube si cambia el hash y `hidden`/`child_answers` quedan fuera del UPDATE). Una solicitud lleva
`outputs` (ejercicios y/o tipos de documento; por defecto `["exercises","summary","cheatsheet"]`): los ejercicios se
publican con `close:false` y el ÚLTIMO documento con `close:true`, que llama a `closeRequest()` (cuenta lo vigente,
anota en `note` lo que faltó y manda UN email). `POST /api/admin/content-requests/:id/close` cierra a mano
(`published` o `failed`). Vía C: `content/<curso>/docs/NN-<slug>.<kind>.json`, los emite `build:course` en el mismo
`.sql` (UPSERT con `WHERE owner_id IS NULL` y retirada de lo que ya no está).

**Niño:** sección «Apuntes» y tira «Apuntes de este tema» en la galaxia y en el path (`components/KidNotes.tsx`),
con lector a pantalla completa (A−/A+), tarjetas que se giran y autocontrol «Ver solución»
(`components/studydoc/`).

**Tutor e impresión** (`components/print/PrintDialog.tsx`, sustituye a la antigua «Ficha PDF»): fuentes = un skill,
un path entero, un curso del catálogo o los **fallos pendientes** de un niño (`GET /api/tutor/children/:id/pending`).
Modos: ficha de práctica, **examen** (puntos que suman 10, tiempo sugerido, tabla de nota y firma; versiones A/B con
su clave y código), repaso de fallos, cálculo rápido, tarjetas (doble cara con columnas espejadas o plegables),
ejemplos resueltos y hoja «Recuerda» (las dos últimas salen de los ejercicios, sin generar nada). Opciones: nº de
preguntas, tipos, reparto de dificultad, compacto, letra, papel, espacio de trabajo, clave simple o explicada
(siempre al final y en página aparte), cuadernillo de 1-6 fichas, «evitar repetidas» (historial en
`localStorage`) y «pack de estudio» (resumen y hoja de trucos delante). **El papel cambia por materia y edad**
(`print/profiles.ts`): en matemáticas, recuadro de resultado y cuadrícula de trabajo, problemas con Datos /
Operaciones / Solución y cuentas en cuadrícula; en lengua e idiomas, renglones (pauta Montessori en 1.º-2.º de
Primaria, doble pauta en 3.º-4.º); en sociales, renglones y frases completas; la letra crece en los cursos bajos y
los huecos tienen tres anchos fijos para no chivar la respuesta. En el panel, los paths se agrupan en una fila
plegable con acciones del path entero, cada contenido tiene «Documentos (N)» y hay un grupo «Cursos del catálogo».

## 9. Deploy e infraestructura

Todo Cloudflare, free tier (ver `DEPLOY.md`). Config en `apps/api/wrangler.toml`:
- Worker `app`, `compatibility_date = 2026-07-01`, dominio custom `app.smart-kids.uk`.
- D1 `smartkids` con `database_id` **real ya commiteado** en el toml (no es secreto; en local no se usa).
  **R2**: `[[r2_buckets]]` binding `UPLOADS`, bucket `smartkids-uploads` (R2 activado en la cuenta; free tier).
- **Secrets de producción por `wrangler secret put`** (no en el toml ni en `.dev.vars`):
  `RESEND_API_KEY`, `EMAIL_FROM`, `CONTENT_IMPORT_TOKEN` (token de máquina para el endpoint de import de contenido).
  En local, `.dev.vars` (gitignored) define `EMAIL_DEV_LINKS=true` y el `CONTENT_IMPORT_TOKEN` local.
- Migraciones D1 al día hasta **`0022`** (0008 = contenido privado + solicitudes, 0009 = config de generación,
  0010 = `coin_awards`, 0016 = retirada de plantillas, 0017 = índices, 0018 = `question_types`/`session_length`/
  `source_request_id` en solicitudes y `session_length` en skills, 0019 = `exercise_reports`, 0020 = `child_profiles.mascot`, 0021 = `content_requests.examples`,
  0022 = `study_docs` + `child_study_docs` + `outputs`/`doc_count` en solicitudes). Migrar **producción**: `pnpm db:migrate:remote` (toca
  datos reales, cuidado). Los scripts `db:migrate`/`db:seed` del paquete api son **solo `--local`**.

## 10. Git e identidad — CRÍTICO

El usuario mantiene **dos identidades de GitHub que deben permanecer separadas** (personal vs trabajo).
Este repo es **personal** y su identidad está configurada **a nivel LOCAL del repo, nunca global**:

- `user.name = vrisco`, `user.email = vrisco.mail@gmail.com` (el usuario quiere su Gmail en los commits, no el noreply).
- Remoto: `origin = git@github-personal:vrisco/smartkids.git` (alias SSH `github-personal` en `~/.ssh/config`).

Reglas: **NO** configures identidad git global. **NO** cambies el remoto a la cuenta de trabajo
(`vrisco-neuronal-ai`). **NO** uses el `gh` CLI aquí (está autenticado en la cuenta de trabajo).
**Commitea o hagas push solo cuando el usuario lo pida**; si trabajas sobre `main`, plantea una rama primero.
Mensajes de commit: **Conventional Commits en español** con scope y, para hitos, etiqueta `— M#`.

## 11. Gotchas / cosas que NO hacer (resumen)

- **No edites el SQL de `apps/api/migrations/` a mano**: cambia `schema.ts` y corre `pnpm --filter @smartkids/api run db:generate`.
  Las migraciones `0004`–`0007` están renombradas a mano y el `_journal.json` está sincronizado; regenerar sin cuidado lo desincroniza.
- **`POST /api/session/attempt` ES la fuente de verdad de aciertos** (ya endurecido, no lo revierta): corrige EN
  SERVIDOR con `grade()`, valida acceso al skill (`childCanAttemptSkill`, 403 si no es de un curso/skill del niño),
  y el anti-farm es ATÓMICO (`coin_awards`, `INSERT ON CONFLICT DO NOTHING RETURNING`). `GET /api/session/next` ya
  NO envía la solución al cliente (`redactForClient`). No reintroduzcas confianza en el cliente para los aciertos.
- **No hardcodees secretos** en `wrangler.toml` ni en el repo. **No pongas `EMAIL_DEV_LINKS=true` en prod.**
- **No commitees** `out/`, `dist/`, `.wrangler/`, `.dev.vars` (ya gitignored).
- Código muerto conocido: `apps/web/src/screens/FamilyHome.tsx` y `ParentPanel.tsx` son stubs (`export {}`); hay
  CSS de pantallas eliminadas en `app.css`/`auth.css`. No los tomes como referencia.
- Detalles frágiles ya conocidos (no son bugs a arreglar sin pedirlo):
  `MathText` solo entiende fracciones `entero/entero`; el `Starfield` no reacciona al cambio de tema en caliente.
  (La racha ya es real, `computeStreak`; el curso escolar del niño lo elige el tutor, `""` = sin definir.)

## 12. Mapa rápido de ficheros

| Necesitas… | Mira en |
|---|---|
| Rutas de la API y lógica de negocio | `apps/api/src/index.ts` |
| Sesiones, PBKDF2, tokens, rate-limit | `apps/api/src/auth.ts` |
| Email (Resend + mock + layout) | `apps/api/src/email.ts` |
| Esquema de la BD (tablas Drizzle) | `apps/api/src/db/schema.ts` |
| Migraciones D1 | `apps/api/migrations/` (generadas; no editar a mano) |
| Seed / credenciales demo | `apps/api/seed.sql` |
| CLI de admin | `apps/api/scripts/admin.mjs` |
| Config del Worker (bindings, dominio, D1) | `apps/api/wrangler.toml` |
| Enrutado por rol de la SPA | `apps/web/src/App.tsx` |
| Cliente API + `tx()` | `apps/web/src/api.ts` |
| Pantallas | `apps/web/src/screens/` |
| Iconos SVG | `apps/web/src/components/Icon.tsx` |
| Personajes del niño: avatar y compañero (Orbi + animales astronauta) | `apps/web/src/components/Mascot.tsx` |
| Cómo va el niño en cada curso/ficha + «Repasar fallos» | `apps/web/src/components/KidProgress.tsx`, `progresoDelNino` en `index.ts` |
| Tokens de diseño y estilos | `apps/web/src/styles/` (`tokens.css` primero) |
| i18n de la UI | `apps/web/src/i18n.ts` |
| Modelo unificado del ejercicio (10 tipos) + grading | `packages/shared/src/exercise.ts`, `grading.ts` |
| Aritmética exacta de las cuentas en columna y factores primos | `packages/shared/src/arith.ts` |
| Inputs de ejercicio en la web (10 tipos) | `apps/web/src/components/ExerciseInput.tsx` |
| Cuadrícula de cuentas y escalera de factores (pantalla, resuelta y papel) | `apps/web/src/components/ColumnOps.tsx` |
| Pipeline de contenido (spec-driven, Vía A) | `tools/content-gen/src/generate.ts` |
| Cursos fijos versionados (Vía C) + builder | `content/<curso>/`, `tools/content-gen/src/build-course.ts` |
| Modelo de los documentos de estudio + catálogo de tipos y materias | `packages/shared/src/studydoc.ts`, `catalog.ts` |
| Documento de estudio en pantalla y en papel, tarjetas | `apps/web/src/components/studydoc/` |
| «Apuntes» del niño | `apps/web/src/components/KidNotes.tsx` |
| Imprimir: diálogo, perfiles por materia/edad, selección, papel | `apps/web/src/components/print/` |
| Texto con `**negrita**` y `$...$` | `apps/web/src/components/Txt.tsx` |
| Skill de generación de contenido | `.claude/skills/smartkids_content/SKILL.md` |
| Cómo desplegar | `DEPLOY.md` |
| Modelo de datos a fondo (30 tablas, auth, economía) | `docs/ARCHITECTURE.md` |
| Decisiones de arquitectura (el porqué) | `docs/adr/` |
| Catálogo de endpoints por rol | `docs/API.md` |
| Convenciones y gotchas del backend | `apps/api/CLAUDE.md` |
| Convenciones y gotchas del frontend | `apps/web/CLAUDE.md` |
