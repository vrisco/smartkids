# CLAUDE.md — guía para Claude Code

Guía operativa del monorepo **smartkids** («Órbita»). Léela entera antes de tocar código.

Convenciones de escritura de este repo: **todo en español**, **sin emojis** en la UI ni en textos
(preferencia fija del usuario y política del propio proyecto). Mantén esa norma también en la doc.

**Documentación relacionada** (más detalle): `docs/ARCHITECTURE.md` (modelo de datos, jerarquía de
usuarios, economía de recompensas, flujos de auth, pipeline de contenido), `docs/API.md` (catálogo de endpoints
por rol) y **`docs/adr/`** (Architecture Decision Records: el PORQUÉ de las decisiones grandes — modelo unificado
del ejercicio, generación de contenido, contenido privado del hogar, anti-farm atómico). Hay además `CLAUDE.md`
anidados en `apps/api/` y `apps/web/` con las convenciones y gotchas de cada subsistema (se auto-cargan al
trabajar en esas carpetas). Skill del proyecto en `.claude/skills/smartkids_content/` (genera contenido).

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
contenido** (lo más reciente): los **7 tipos de ejercicio** con modelo unificado en `packages/shared`, motor de
sesión endurecido (grading EN SERVIDOR + anti-farm ATÓMICO + aleatoriedad + repaso obligatorio), **dos vías de
generación** (skill `smartkids_content`) y **contenido privado del hogar** (fichas/paths que el tutor genera para
sus niños). Detalle en §8; el PORQUÉ en `docs/adr/`.

Pendiente (no empieces ninguno sin confirmarlo con el usuario):
- Motor pedagógico **FSRS real** (hoy la subida/bajada de `mastery` es heurística en `POST /api/session/attempt`).
- **Generación real con Claude API** requiere `ANTHROPIC_API_KEY` en el entorno (el pipeline ya es spec-driven
  multi-tipo; sin key corre en `--mock`; la Vía B multimodal "que ve" las figuras del PDF también la necesita).
- Más asignaturas e idiomas de contenido.
- Iconos PWA (`vite.config.ts` tiene `manifest.icons: []`).
- Agrupar los paths en el panel del tutor (hoy los módulos de un path se listan sueltos).

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
| `pnpm format` / `pnpm format:check` | Prettier (defaults, sin config propia). |
| `pnpm deploy` | Build de la web **y luego** `wrangler deploy` del Worker. El orden importa. |
| `pnpm db:migrate:remote` | Aplica migraciones a la D1 **de producción**. |
| `pnpm db:seed:remote` | Ejecuta `apps/api/seed.sql` contra la D1 **de producción**. |

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

Drizzle sobre D1/SQLite, **24 tablas**, esquema en `apps/api/src/db/schema.ts`. La frontera está marcada con
comentarios de sección en el propio schema:

- **CONTENIDO (inmutable, versionado):** `subjects`, `skills`, `skill_prerequisites`, `content_packages`,
  `exercise_templates`. IDs semánticos estables (`MATH.ESO5.FRAC.ADD`); versionado por `content_packages.version`
  y `exercise_templates.content_version`. El contenido **nunca se muta in-place**: se publican nuevas versiones.
  `skills`/`content_packages` llevan `owner_id` (null = catálogo GLOBAL; set = **PRIVADO del hogar** del tutor);
  `skills` además `coins_per_correct` (puntos por acierto) y `path_id`/`path_name`/`module_index` (agrupar módulos).
- **PROGRESO (mutable, por niño):** `skill_progress`, `attempts`, `coin_awards` (registro ATÓMICO de "ya cobrado"
  por (niño, ejercicio), PK compuesta → anti-farm sin carrera), y la economía `wallets`, `wallet_ledger`,
  `redemptions`. Cada intento congela `content_version` para que el histórico no se corrompa si el contenido evoluciona.
- **Identidad y acceso:** `parent_accounts` (tutores/admin, `role`), `child_profiles`, `courses`,
  `child_courses` (acceso niño↔curso), `child_rewards` (acceso niño↔recompensa), `child_skills`
  (acceso niño↔skill PRIVADO), `rewards`.
- **Contenido a medida (Vía B):** `content_requests` (petición del tutor: material + config + estado) y
  `content_request_assets` (metadatos de los ficheros; el binario vive en R2). Ver §8.
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
- **CERO emojis.** Todo icono es SVG vía `components/Icon.tsx` (unión cerrada `IconName`) y todo avatar vía
  `components/Avatar.tsx` (claves `orbi/fox/panda/...`, normaliza legado emoji con `avatarKeyOf`). No metas emojis.
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

## 8. Sistema de contenido (7 tipos + 3 vías de publicación)

**Modelo unificado del ejercicio = fuente ÚNICA de verdad en `packages/shared`** (`src/exercise.ts` esquemas Zod
de los 7 tipos + `src/grading.ts` la lógica). Lo importan la API Y la web (se acabó la divergencia con D1).
- 7 tipos: `multiple_choice`, `numeric`, `fill_in_blank` (huecos `{{1}}`), `true_false`, `ordering`, `matching`,
  `step_problem`.
- `grade(ex, answer)` corrige EN SERVIDOR; `redactForClient(ex)` quita la solución antes de enviar (el niño NUNCA
  ve la respuesta); `toStoredPayload()/exerciseFromRow()` mapean a la columna `payload` JSON; `validateExercise()`
  (self-check: la clave marcada corrige acierto) lo usa el pipeline.
- La web importa SOLO **tipos** de `shared` (`import type` → cero runtime, `zod` no entra en el bundle). En
  `tsconfig.base.json` está `allowImportingTsExtensions` para que el pipeline importe `shared` bajo
  `node --experimental-strip-types` (los imports internos de `shared` llevan extensión `.ts`).

**Motor de sesión** (`GET /api/session/next` + `POST /api/session/attempt`, en `apps/api/src/index.ts`): corrige
los 7 tipos en servidor, baraja opciones por servida, evita plantillas vistas hace poco, y tiene **fase de repaso
obligatoria** (al fallar sirve ejercicios NUEVOS del mismo concepto hasta acertar, con tope; lógica en
`apps/web/src/screens/Session.tsx`). El cuerpo de `attempt` es `{ answer }` (unión discriminada `AnswerSchema`),
con compat del viejo `selectedOptionId`. Inputs de los 7 tipos en `apps/web/src/components/ExerciseInput.tsx`.

**Vía A — desde una descripción** (catálogo GLOBAL): `tools/content-gen/src/generate.ts` es spec-driven multi-tipo.
Lee una **spec JSON** (`--spec <ruta>`, ver `spec.example.json`); `--mock` sin coste; real con `ANTHROPIC_API_KEY`
(`claude-opus-4-8`, salida Zod). Valida con `validateExercise`, escribe `out/<pkg>.json`+`.sql` (**`out/` gitignored**)
y se aplica con `wrangler d1 execute` (a mano; el `.sql` requiere la D1 ya sembrada).

**Vía B — desde material del tutor** (PRIVADO del hogar): el tutor sube fotos/PDF/texto **o solo una descripción**
desde el panel → `POST /api/tutor/content-requests` (multipart, R2) crea una `content_requests` con su config
(`num_questions`, `points_per_correct`, `modules`; título opcional). La skill lista las pendientes, descarga los
assets, genera, y publica vía `POST /api/admin/content/import` (auth: Bearer `CONTENT_IMPORT_TOKEN` **o** sesión de
admin): crea skill PRIVADO (`owner_id`=tutor) + paquete + plantillas, lo asigna al niño (`child_skills`), marca la
solicitud `published` y **envía email al tutor**. `modules>1` genera un **path** de N módulos. Una solicitud aún no
procesada (status `uploaded`) es **editable** (`POST .../content-requests/:id` añade ficheros/campos;
`DELETE .../:id/assets/:assetId` quita uno).

**Vía C — cursos fijos** (catálogo GLOBAL, redactados a mano y VERSIONADOS en el repo): a diferencia de la Vía A
(que genera con IA a `out/` gitignored), estos cursos viven en **`content/<curso>/`** (fuente de verdad EDITABLE, en
git): un `course.json` (metadatos + lista ORDENADA de módulos) y un fichero por módulo (`NN-<slug>.json` con
`{ skill, exercises }`; los ejercicios NO llevan los campos de contexto —`exerciseId`/`packageId`/`skillId`/
`language`—, los inyecta el builder). `tools/content-gen/src/build-course.ts` (script `build:course`) valida cada
ejercicio (`validateExercise` + Zod) y emite UN `.sql` **idempotente** (UPSERT de subject/curso/skills, cadena de
`skill_prerequisites` por orden de módulo, `DELETE`+`INSERT` de paquetes/plantillas) en `out/<courseId>.sql`. Se
aplica con `wrangler d1 execute` (local o `--remote`). **Evolucionar** = editar el JSON del módulo y re-ejecutar
(los paquetes se reemplazan por completo). El niño ve el curso cuando el tutor se lo **asigna** (asignatura+nivel);
`owner_id` NULL = global. Primer curso: `content/math-eso2-operaciones/` (2º ESO, nivel `ESO-2`, 10 módulos, 118
ejercicios). Nota: el `gradeBand` del niño es cosmético (HUD), NO filtra contenido: lo entrega el curso asignado.

**Skill del proyecto** `.claude/skills/smartkids_content/SKILL.md`: guía paso a paso de las vías A y B. Invócala con
`/smartkids_content <descripción>` o `/smartkids_content pendientes`. El frontmatter usa `name`+`description` (NO
`trigger`). **OJO discovery**: Claude Code solo escanea `.claude/skills/` de `~/` y de la RAÍZ del workspace, no de
subcarpetas; para verla, abre el workspace EN `smartkids/` (o usa la copia personal `~/.claude/skills/smartkids_content/`).

**Acceso a contenido privado:** un skill privado solo lo ve/juega un niño si su `owner_id` sigue en el HOGAR del
niño **Y** tiene `child_skills` asignado. `childCanAttemptSkill`, `GET /api/skills` y `GET /api/child/me` revalidan
el hogar (el grant `child_skills` NO basta). Al desvincular cónyuge (`DELETE /api/tutor/spouse`) se limpian los
grants cruzados de recompensas Y de skills.

## 9. Deploy e infraestructura

Todo Cloudflare, free tier (ver `DEPLOY.md`). Config en `apps/api/wrangler.toml`:
- Worker `app`, `compatibility_date = 2026-07-01`, dominio custom `app.smart-kids.uk`.
- D1 `smartkids` con `database_id` **real ya commiteado** en el toml (no es secreto; en local no se usa).
  **R2**: `[[r2_buckets]]` binding `UPLOADS`, bucket `smartkids-uploads` (R2 activado en la cuenta; free tier).
- **Secrets de producción por `wrangler secret put`** (no en el toml ni en `.dev.vars`):
  `RESEND_API_KEY`, `EMAIL_FROM`, `CONTENT_IMPORT_TOKEN` (token de máquina para el endpoint de import de contenido).
  En local, `.dev.vars` (gitignored) define `EMAIL_DEV_LINKS=true` y el `CONTENT_IMPORT_TOKEN` local.
- Migraciones D1 al día hasta **`0010`** (0008 = contenido privado + solicitudes, 0009 = config de generación,
  0010 = `coin_awards`). Migrar/sembrar **producción**: `pnpm db:migrate:remote` / `pnpm db:seed:remote` (tocan
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
- Detalles frágiles ya conocidos (no son bugs a arreglar sin pedirlo): `Hud` pinta la inicial en vez del avatar y
  la racha está hardcodeada a `7`; `gradeBand` se fija a `"ESO-5"` al crear niño; `MathText` solo entiende fracciones
  `entero/entero`; el `Starfield` no reacciona al cambio de tema en caliente.

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
| Iconos / avatares SVG | `apps/web/src/components/Icon.tsx`, `Avatar.tsx` |
| Tokens de diseño y estilos | `apps/web/src/styles/` (`tokens.css` primero) |
| i18n de la UI | `apps/web/src/i18n.ts` |
| Modelo unificado del ejercicio (7 tipos) + grading | `packages/shared/src/exercise.ts`, `grading.ts` |
| Inputs de ejercicio en la web (7 tipos) | `apps/web/src/components/ExerciseInput.tsx` |
| Pipeline de contenido (spec-driven, Vía A) | `tools/content-gen/src/generate.ts` |
| Cursos fijos versionados (Vía C) + builder | `content/<curso>/`, `tools/content-gen/src/build-course.ts` |
| Skill de generación de contenido | `.claude/skills/smartkids_content/SKILL.md` |
| Cómo desplegar | `DEPLOY.md` |
| Modelo de datos a fondo (24 tablas, auth, economía) | `docs/ARCHITECTURE.md` |
| Decisiones de arquitectura (el porqué) | `docs/adr/` |
| Catálogo de endpoints por rol | `docs/API.md` |
| Convenciones y gotchas del backend | `apps/api/CLAUDE.md` |
| Convenciones y gotchas del frontend | `apps/web/CLAUDE.md` |
