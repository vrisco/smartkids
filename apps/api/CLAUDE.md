# CLAUDE.md — backend (`apps/api`, `@smartkids/api`)

Worker de Cloudflare (Hono) que sirve la API `/api/*` y delega el resto a los Static Assets (la SPA).
Guía global en `../../CLAUDE.md`; modelo de datos en `../../docs/ARCHITECTURE.md`; endpoints en `../../docs/API.md`.

## Ficheros

- `src/index.ts` — router Hono + toda la lógica de negocio y los helpers de autorización.
- `src/auth.ts` — sesiones (cookies + D1), PBKDF2, tokens de un solo uso, rate-limiting.
- `src/email.ts` — envío por Resend (con modo mock y `emailLayout`).
- `src/db/index.ts` — `getDb(d1)` = `drizzle(d1, { schema })`.
- `src/db/schema.ts` — las tablas Drizzle (hoy 27). **Fuente de verdad del esquema.**
- `migrations/` — SQL generado por drizzle-kit (no editar a mano) + `meta/_journal.json`.
- `seed.sql` — datos iniciales + credenciales demo.
- `scripts/admin.mjs` — CLI de bootstrap del admin.
- `wrangler.toml` — bindings (`DB`, `ASSETS`), dominio custom, `database_id` de producción.

## Comandos

```bash
pnpm --filter @smartkids/api run dev          # wrangler dev (:8787), D1 local en .wrangler/
pnpm --filter @smartkids/api run typecheck    # tsc --noEmit
pnpm --filter @smartkids/api run db:generate  # drizzle-kit generate → migrations/
pnpm --filter @smartkids/api run db:migrate    # aplica migraciones (SOLO --local)
pnpm --filter @smartkids/api run db:seed       # aplica seed.sql   (SOLO --local)
pnpm --filter @smartkids/api run admin -- create <email> <pw> [--remote]
```

Para **producción**: `pnpm db:migrate:remote` (toca datos reales). **No existe `db:seed:remote`**: el seed
borra las 27 tablas y crea cuentas demo con contraseñas publicadas en el repo, así que es SOLO local.

## Convenciones (síguelas al añadir código)

- **Guard explícito por handler.** No hay middleware. Devuelve `string | Response`; el handler hace
  `if (typeof x !== "string") return x;`. Guards: `requireParent`, `requireAdmin`, `childOrOwner`; helpers
  `ownsProfile`, `householdIds`, `hasCourse`. **Un endpoint sin guard queda abierto.**
- **DB por petición**: `const db = getDb(c.env.DB)` al inicio del handler. Tablas desestructuradas de `schema`.
- **IDs con prefijo**: `par_` / `par_admin_` / `kid_` / `rw_`; el resto UUID o `sha256`. Genera con `crypto.randomUUID()`.
- **Tiempos ISO string** (`new Date().toISOString()`); las columnas de fecha son `text`, comparables lexicográficamente.
- **Emails y usernames** siempre `.trim().toLowerCase()`. `username` validado con `USERNAME_RE = /^[a-z0-9._-]{3,}$/`.
- **i18n**: `name_i18n` es JSON `{ es, en }`; al crear/editar recompensas de tutor se guarda el mismo texto en ambos.
- **Autorización del hogar** (niños, recompensas) siempre vía `householdIds`/`ownsProfile`, que exigen vínculo de
  cónyuge **simétrico**. No introduzcas rutas que asuman acceso por vínculo asimétrico.
- **Cambios de esquema**: edita `schema.ts` y corre `db:generate`. **No** escribas SQL de migración a mano ni
  edites `meta/_journal.json` (las 0004–0007 se renombraron a mano y el journal está sincronizado).

- **Publicar contenido NO borra plantillas.** `attempts` y `coin_awards` referencian
  `exercise_templates` con FK sin `ON DELETE`, así que un `DELETE` por `package_id` falla en cuanto un niño ha
  respondido. El import y los dos builders hacen **UPSERT por id**, retiran el paquete entero antes (`retired=1`)
  y cada upsert reactiva lo suyo. `hidden` (curación del tutor) queda FUERA del SET; `retired` (retirada
  automática) es una columna distinta a propósito. Migración `0016`.
- **Filtra `retired` y `hidden`** en cualquier consulta que sirva o acepte un ejercicio: los ids son adivinables
  (`<paquete>_<n>`) y las retiradas se acumulan para siempre. Los conteos que ven tutor y niño (`GET
  /api/tutor/content`, `GET /api/child/me`) cuentan solo plantillas vigentes (y visibles, en el del niño).
- **Límites de D1 / plan Free** (1000 subpeticiones y 10 ms de CPU por invocación, ~100 parámetros ligados por
  consulta): no metas listas de ids grandes en `inArray` (usa subconsulta, como `deletePrivateSkillCascade` con
  `coin_awards`) y escribe en lote con `db.batch` por tandas (el import va de 50 en 50). Los paquetes grandes se
  publican troceados (`offset` en el import; ids de plantilla `<paquete>_<offset+n>`; solo el lote 0 retira).
- **Config de generación de la Vía B** en un único sitio: `requestConfigFromForm()` (lo que no venga se hereda de la
  solicitud previa). Rangos: `numQuestions` 5..200, `sessionLength` 3..30, `modules` 1..6, `pointsPerCorrect` 1..50,
  `questionTypes` = tipos válidos del `ExerciseTypeSchema` (vacío = variados, desconocidos se descartan). Se genera
  `targetExercises = ceil(numQuestions * GENERATION_EXTRA)` con `GENERATION_EXTRA = 1.5`.
- **R2 compartido entre solicitudes**: una copia regenerada (`mode=copy`) reutiliza los objetos de R2 del original.
  Borra SIEMPRE con `deleteR2IfUnreferenced` (solo si ninguna fila de `content_request_assets` apunta al `r2_key`),
  nunca con `UPLOADS.delete` directo.
- **Regeneración en sitio** (`mode=replace`): la solicitud vuelve a `uploaded` conservando `skill_id`/`package_id`
  (puntero a lo publicado); `GET /api/admin/content-requests` la marca `regenerate` con sus `previousSkills`. En el
  import, `replaceSkillContent` retira todo lo vigente del skill (de cualquier paquete) y `retireSkillIds` (solo en
  la llamada que cierra) borra skills sobrantes, filtrados a los de ESA solicitud y nunca el actual.

## Gotchas / cuidado

- **Sin transacciones reales salvo `db.batch`.** Cascadas (`deleteChildCascade`, `deleteRewardCascade`, borrado de
  tutor) son secuencias no atómicas; un fallo a mitad deja huérfanos. Las FK son `ON DELETE no action`: nunca
  borres un padre/niño/skill por SQL directo.
- **Decremento del monedero atómico condicional**: `spend` usa
  `UPDATE wallets SET balance = balance - cost WHERE profile_id = ? AND balance >= cost RETURNING balance`.
  El `wallet_ledger`/`redemptions` se insertan **después**, no atómicamente: si el Worker muere en medio, el
  saldo baja sin registro. No lo empeores.
- **Economía por convención de texto**: `earnedSince` filtra `reason LIKE 'exercise:%'`. Mantén los prefijos del
  ledger (`exercise:`, `redeem:`, `refund:`). Ventanas **rodantes** (7d/30d), no de calendario.
- **`POST /api/session/attempt` es autoritativo** (endurecido, M9): corrige EN SERVIDOR con `grade()` de
  `@smartkids/shared`, valida acceso con `childCanAttemptSkill` (403 si no) y el anti-farm es ATÓMICO
  (`coin_awards`, `INSERT ON CONFLICT DO NOTHING RETURNING`). El cuerpo es `{ answer }` (`AnswerSchema`), con
  compat del viejo `selectedOptionId`. Las monedas por acierto salen de `skills.coins_per_correct` o el global.
  La respuesta incluye `feedback`, `solution` y `theory` (la web los enseña al fallar).
- **`GET /api/session/next`** valida el curso/skill (403 si no), NO envía la solución (`redactForClient`) y baraja
  opciones (`shuffleRender`). Banco ligero (solo id+tipo, hasta 1000); selección aleatoria PRIORIZADA
  (`PRIORIDAD_FALLOS = 0.7` hacia lo fallado la última vez, pesos por historial, lo reciente descansa, penaliza
  repetir tipo). `?exclude=` = lo ya servido en la sesión (no repite y mide la variedad); `?exercise=<id>` sirve
  uno concreto (la sesión de repaso de fallos). Devuelve `sessionLength` del skill (`SESSION_LENGTH_DEFAULT = 5`).
- **Rate-limiting caro y con carrera**: cada check hace DELETE de poda + COUNT sobre `login_attempts`.
- **`EMAIL_DEV_LINKS`** devuelve enlaces de reset en la respuesta HTTP: **jamás `true` en producción.**
- Secrets de prod (`RESEND_API_KEY`, `EMAIL_FROM`) van por `wrangler secret put`, no en `wrangler.toml` ni `.dev.vars`.
