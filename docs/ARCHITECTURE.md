# Arquitectura de smartkids

> **Nota (M9, 2026-07-12):** el **sistema de contenido** (7 tipos con modelo unificado en `packages/shared`,
> generación en dos vías, contenido privado del hogar, anti-farm atómico) es posterior a partes de este documento.
> Para el estado ACTUAL de contenido/economía la verdad viva es `../CLAUDE.md` §8, `docs/adr/` y `apps/api/src/db/schema.ts`
> (24 tablas). Este documento conserva el modelo de datos base, la jerarquía de usuarios y los flujos de auth.

Referencia profunda del sistema. Para la guía operativa breve, ver `../CLAUDE.md`. Para el catálogo de
endpoints, ver `API.md`. Este documento describe el **modelo de datos**, la **jerarquía de usuarios**, la
**economía de recompensas**, los **flujos de autenticación**, el **ciclo de vida de una petición** y el
**pipeline de contenido**. Todo verificado contra el código (`apps/api/src/`, `apps/web/src/`, `tools/content-gen/`).

---

## 1. Topología del despliegue

Un **único Worker de Cloudflare** (`name = "app"`, `apps/api/src/index.ts`) atiende todo en el mismo origen:

```
                    ┌──────────────────────── Worker "app" ────────────────────────┐
  navegador  ─────► │  Hono router                                                  │
  (SPA/PWA)         │    /api/*   ──► handlers (auth, perfiles, juego, recompensas)  │ ──► D1 "smartkids"
                    │    *        ──► ASSETS.fetch  (SPA de apps/web/dist)           │      (SQLite, binding DB)
                    └───────────────────────────────────────────────────────────────┘
```

- **Sin CORS**: la SPA y la API comparten origen, así que las cookies de sesión funcionan con `SameSite=Lax`
  y sin `credentials: "include"` en el cliente.
- **Bindings** (`wrangler.toml`): `DB` (D1), `ASSETS` (Static Assets → `../web/dist`, `not_found_handling =
  single-page-application`). Variables de runtime: `RESEND_API_KEY?`, `EMAIL_FROM?`, `EMAIL_DEV_LINKS?`.
- **No hay KV, R2 ni Durable Objects.** Todo el estado con vida (sesiones, tokens, rate-limit) se persiste en D1.
- En **local** (`pnpm dev`), Vite (`:5173`) sirve la SPA y proxya `/api/*` al `wrangler dev` (`:8787`), que corre
  el runtime real de Workers con D1/KV/R2 locales en `.wrangler/`.

## 2. Ciclo de vida de una petición

1. El cliente (`apps/web/src/api.ts`) llama con ruta **relativa** `/api/...` y cookies de mismo origen.
2. El Worker enruta con Hono. `GET /api/health` responde sin auth. Todo lo demás pasa por un **guard explícito**
   dentro del handler (no hay middleware global).
3. El guard resuelve la identidad leyendo la cookie de sesión, calculando `sha256(token)` y buscando la fila en
   `sessions` / `child_sessions`. Si caducó, la borra (expiración perezosa) y devuelve `null`.
4. El handler instancia Drizzle por petición (`const db = getDb(c.env.DB)`), ejecuta la lógica y responde JSON.
5. Lo que no casa con `/api/*` se delega a `ASSETS.fetch(c.req.raw)` → la SPA.

**Convención de guards:** devuelven `string` (el id autorizado) o un `Response` de error. El handler hace
`const x = await requireParent(c, db); if (typeof x !== "string") return x;`. Si añades un endpoint y olvidas el
guard, queda abierto.

## 3. Modelo de datos (Drizzle sobre D1/SQLite)

Esquema en `apps/api/src/db/schema.ts`. **20 tablas.** Todas las PK son `text` (IDs de aplicación, no
autoincrement) salvo las PK compuestas de las tablas de unión. **Todas las marcas de tiempo son `text` ISO-8601**
(`new Date().toISOString()`), comparables lexicográficamente. Todas las FK son `ON DELETE no action` (**no hay
cascada a nivel de BD**; las cascadas se hacen en aplicación).

La frontera CONTENIDO / PROGRESO está marcada con comentarios de sección en el propio `schema.ts`.

### 3.1 Identidad

**`parent_accounts`** — tutores y administradores.

| Columna | Tipo | Constraints | Uso |
|---|---|---|---|
| `id` | text | PK | `par_...` (o `par_admin_...` desde la CLI) |
| `email` | text | UNIQUE, NOT NULL | login |
| `password_hash` | text | NOT NULL | PBKDF2 en formato `saltHex:hashHex` |
| `email_verified` | integer(bool) | NOT NULL, def `false` | email confirmado |
| `role` | text | NOT NULL, def `'tutor'` | `'admin'` \| `'tutor'` |
| `spouse_id` | text | nullable | co-tutor; vínculo **simétrico** |
| `spouse_pending_from` | text | nullable | id de quien envió la invitación de cónyuge (pendiente) |
| `locale_format` | text | NOT NULL, def `'es-ES'` | formato regional |
| `created_at` | text | NOT NULL | ISO |

**`child_profiles`** — perfiles de niño.

| Columna | Tipo | Constraints | Uso |
|---|---|---|---|
| `id` | text | PK | `kid_...` |
| `parent_id` | text | FK → parent_accounts.id, NOT NULL | tutor propietario |
| `display_name` | text | NOT NULL | nombre visible |
| `avatar` | text | NOT NULL, def `'orbi'` | clave de avatar (ver Avatar.tsx) |
| `birth_year` | integer | nullable | |
| `grade_band` | text | NOT NULL | nivel, p.ej. `ESO-5` |
| `login_pin_hash` | text | nullable | PIN de acceso (mismo PBKDF2 que el password) |
| `username` | text | nullable, UNIQUE (`child_username_uq`) | login propio del niño |
| `preferred_locale` | text | NOT NULL, def `'es'` | |
| `region` | text | nullable | |

Nota: `username` es UNIQUE sobre columna nullable → en SQLite conviven varios `NULL`; la unicidad solo aplica a
usernames no nulos.

### 3.2 Contenido (inmutable, versionado)

| Tabla | Claves | Para qué |
|---|---|---|
| `subjects` | PK `id` (p.ej. `math`) | asignatura; `name_i18n` JSON |
| `skills` | PK `id` (p.ej. `MATH.ESO5.FRAC.ADD`), FK `subject_id` | destreza; `grade_band`, `difficulty_base`, `position` |
| `skill_prerequisites` | PK compuesta `(skill_id, prerequisite_id)`, ambas FK → skills | grafo de prerrequisitos |
| `content_packages` | PK `id`, FK `subject_id` | paquete versionado; `version`, `status` (def `published`) |
| `exercise_templates` | PK `id`, FK `package_id`, FK `skill_id` | plantilla; `type`, `stem`, `payload` (JSON), `content_version`, dificultad |

Versionado explícito: `content_packages.version`, `exercise_templates.content_version` (def `1.0.0`). El contenido
se trata como inmutable; una nueva tanda es un paquete/versión nuevos, no una mutación in-place. `payload` de la
plantilla es JSON con `options` (id/text/isCorrect) y `feedback` (correct/incorrect) para los `multiple_choice`.

### 3.3 Progreso (mutable, por niño)

| Tabla | Claves | Para qué |
|---|---|---|
| `skill_progress` | PK compuesta `(profile_id, skill_id)` | dominio por skill: `mastery_score`, `consecutive_correct`, `total_attempts`, `status`, `fsrs` (JSON, hoy sin usar) |
| `attempts` | PK `id`, FK profile/skill/template | historial; `content_version` (congela la versión servida), `correct`, `response_time_ms`, `difficulty_served`, `ts` |

`attempts.content_version` es el puente entre progreso y contenido: cada intento recuerda qué versión de
contenido vio, de modo que el histórico no se corrompe cuando el contenido evoluciona.

**Actualización del dominio** (en `POST /api/session/attempt`, hoy heurística, no FSRS):
`mastery += 0.12 * (1 - mastery)` si acierta, `mastery -= 0.08` si falla; `status = "mastered"` cuando
`mastery >= 0.85`. Cada acierto otorga `COINS_PER_CORRECT = 10` puntos.

### 3.4 Economía / recompensas

| Tabla | Claves | Para qué |
|---|---|---|
| `wallets` | PK `profile_id` (FK) | saldo agregado `balance` (1 por niño) |
| `wallet_ledger` | PK `id`, FK `profile_id` | libro de movimientos: `delta` firmado, `reason` con prefijo, `ts` |
| `rewards` | PK `id` | catálogo (sistema + tutor). Ver semántica abajo |
| `redemptions` | PK `id`, FK profile/reward | canje: `status`, `ts` |
| `child_rewards` | PK compuesta `(child_id, reward_id)` | asignación niño↔recompensa (la concede el tutor) |

**`rewards`** en detalle:

| Columna | Uso |
|---|---|
| `owner_id` | tutor/hogar dueño; `null` = recompensa del sistema (sembrada) |
| `cost` | `spend`: precio en puntos; `goal`: objetivo a acumular |
| `type` | `cosmetic`, `streak_freeze`, `screen_time_voucher`, `manual` (creadas por tutor) |
| `kind` | `spend` (canjeable) \| `goal` (acumular en el tiempo). Def `spend` |
| `period` | solo `goal`: ventana de acumulación `week`\|`month` (`null` = total) |
| `limit_count` | máx. canjes por ventana (`null` = ilimitado) |
| `limit_period` | ventana del límite `all`\|`week`\|`month` (def `all`) |
| `icon` | nombre de icono (recompensas de tutor; def en código `gift`) |
| `payload` | JSON opcional del efecto |
| `name_i18n` | JSON `{ es, en }` |

**Semántica del monedero y los objetivos:**
- **`spend`** (canjear): decremento **atómico condicional** —
  `UPDATE wallets SET balance = balance - cost WHERE profile_id = ? AND balance >= cost RETURNING balance`.
  Si no devuelve filas → `insufficient_funds`. Registra `wallet_ledger` (`delta = -cost`, `reason = redeem:<id>`)
  y crea `redemptions`.
- **`goal`** (objetivo): **NO** descuenta el monedero. Exige que `earnedSince()` ≥ `cost`, donde `earnedSince`
  suma solo los movimientos con `reason LIKE 'exercise:%'` desde el inicio de la ventana. Es «puntos ganados
  haciendo ejercicios en la ventana», independiente del saldo actual.
- **Ventanas rodantes**: `periodStartIso()` calcula `now - 7d` / `now - 30d` / epoch. Un «mes» son 30 días
  fijos, no el mes natural. Aplica tanto a `period` (objetivos) como a `limit_period` (límite de canjes).
- **Estado del canje**: recompensas in-app (`type` en `cosmetic`/`streak_freeze`) quedan `applied` al instante;
  el resto (mundo real / vouchers) quedan `pending` a la espera de que la familia haga `grant` o `reject`.
  Al **rechazar** un `spend` pendiente se **reembolsa** (`delta = +cost`, `reason = refund:<id>`).
- **Prefijos de `reason`**: `exercise:`, `redeem:`, `refund:`, y `daily_goal` (en el seed). La semántica de
  objetivos depende de esta convención de texto (no hay columna tipada): un `reason` mal formado la rompe en silencio.

**Defensa cruzada**: un niño solo puede canjear una recompensa que (a) le esté **asignada** (`child_rewards`) y
(b) pertenezca a su **hogar** (`reward.owner_id` ∈ `householdIds`). La segunda condición protege ante
asignaciones que queden cruzadas al desvincular un cónyuge.

### 3.5 Seguridad / sesiones

| Tabla | Claves | Para qué |
|---|---|---|
| `sessions` | PK `id` = `sha256(token)`, FK `parent_id` | sesión de tutor/admin; `expires_at` |
| `child_sessions` | PK `id` = `sha256(token)`, FK `child_id` | sesión de niño |
| `auth_tokens` | PK `id` = `sha256(token)`, FK `parent_id` | tokens de un solo uso; `type` `verify`\|`reset` |
| `login_attempts` | PK `id` | rate-limit; `ident`, `ts` |

### 3.6 Cursos y asignaciones

| Tabla | Claves | Para qué |
|---|---|---|
| `courses` | PK `id`, FK `subject_id` | curso = asignatura + `grade_band` (p.ej. `course_math_eso5`) |
| `child_courses` | PK compuesta `(child_id, course_id)` | acceso niño↔curso (lo concede el tutor) |

### 3.7 Índices y notas de rendimiento

- Solo hay **dos índices únicos explícitos**: `parent_accounts_email_unique` y `child_username_uq`. El resto de
  tablas (`attempts`, `wallet_ledger`, `redemptions`, `login_attempts`, sesiones, `auth_tokens`) **no tienen
  índices secundarios**; las búsquedas por `profile_id`, `ts`, `parent_id`, `ident`, `expires_at` hacen scan.
- `grade_band` es texto libre repetido en `child_profiles`, `skills`, `content_packages`, `courses`. No hay tabla
  de niveles ni FK: una discrepancia de string (`ESO5` vs `ESO-5`) desalinea contenido y perfil en silencio.
- Los campos JSON (`name_i18n`, `payload`, `fsrs`) se guardan como `text`; `mode: "json"` en Drizzle es
  serialización de app, no validación de BD.

## 4. Jerarquía de usuarios y «hogar»

```
ADMIN  ──crea──►  TUTOR  ──crea──►  NIÑO  ──asignado a──►  CURSO(s) + RECOMPENSA(s)
                    │
                    └──invita (consentimiento bilateral)──►  CÓNYUGE / co-tutor  (comparte TODOS los niños)
```

- **Admin**: `role = 'admin'`. Se crea/resetea **solo por CLI** (`scripts/admin.mjs`). Da de alta tutores
  (`POST /api/admin/tutors`, invitación por email para que el tutor fije su contraseña), los lista, les resetea
  la contraseña por enlace y los borra. **No hay registro público.**
- **Tutor**: `role = 'tutor'`. Crea/edita/borra niños, les asigna cursos y recompensas, gestiona canjes
  pendientes e invita a un cónyuge.
- **Niño**: login propio `username` + PIN (sesión `sk_child` separada). Solo ve lo que su tutor le asignó.
- **Hogar (cónyuge/co-tutor)**: se modela con `spouse_id` (self-reference en `parent_accounts`), **sin tabla de
  unión**. Es efectivo **solo si es simétrico**:
  - `householdIds(db, parentId)` devuelve `[parentId, spouseId]` únicamente si `A.spouse_id = B` **y**
    `B.spouse_id = A`; si no, `[parentId]`. Es la base de todas las consultas «del hogar» (niños, recompensas).
  - `ownsProfile(db, parentId, childId)` concede acceso si el niño es del tutor o de su cónyuge **con el vínculo
    simétrico verificado en ambas cuentas**.
  - **Vinculación con consentimiento bilateral**: `POST /api/tutor/spouse` (invitar) deja `spouse_pending_from`
    en el invitado **sin ningún acceso**; el invitado hace `/accept` (escribe el vínculo simétrico con `db.batch`
    y verifica la simetría posterior, deshaciendo lados colgantes ante carreras) o `/reject`. `DELETE` desvincula
    ambos lados y barre `child_rewards` cruzados entre los dos hogares que se separan.

## 5. Autenticación y seguridad (`apps/api/src/auth.ts`)

- **Sesiones en D1, no JWT.** El token de cookie son 32 bytes aleatorios en hex; en BD se guarda `sha256(token)`
  como `id` de la fila de sesión. Cookies: `sk_session` (tutor) / `sk_child` (niño), `httpOnly`, `SameSite=Lax`,
  `path=/`, `maxAge = 30 días`; `secure` solo si el origen es `https:` (funciona en http local). Expiración
  perezosa (se borra la fila al detectarla caducada; no hay cron).
- **Hashing PBKDF2**: 100.000 iteraciones, SHA-256, `deriveBits(256)`, salt de 16 bytes; almacenado como
  `saltHex:hashHex`. `verifySecret` re-deriva y compara en **tiempo constante**. Se usa igual para el password de
  tutor y para el `login_pin_hash` del niño. `scripts/admin.mjs` replica exactamente este esquema.
- **Tokens de un solo uso** (`auth_tokens`): `verify` (TTL 24h) y `reset` (TTL 1h; invitación de tutor/cónyuge
  reutiliza el tipo `reset` con TTL 7 días; reset iniciado por admin, 24h). `consumeAuthToken` **borra la fila
  siempre** (aunque esté caducada) y solo devuelve el `parentId` si no expiró → efecto un-solo-uso.
- **Rate-limiting** (`login_attempts`): ventana 15 min, máximo 6 intentos por `ident`. Cada comprobación poda
  filas viejas y cuenta. Identificadores: `login:ip:*`, `login:email:*`, `childlogin:ip:*`, `childlogin:user:*`,
  `forgot:ip:*`, `spouse:*`. La IP sale de `cf-connecting-ip` (fallback `local`).
- **Email** (`email.ts`): Resend por `fetch` directo (proveedor intercambiable). Sin `RESEND_API_KEY` → mock
  (`console.log`, devuelve `false`). Con `EMAIL_DEV_LINKS=true`, los endpoints devuelven el enlace en el JSON
  (`devLink`) para probar en local sin proveedor — **nunca en producción** (expondría tokens de reset).

## 6. Flujos clave

- **Alta de tutor**: admin `POST /api/admin/tutors` → se crea la cuenta con password aleatoria inservible + email
  de invitación (enlace `reset`) → el tutor abre `/reset`, fija su contraseña (queda `email_verified = true`).
  Idempotente: reinvitar a un tutor aún sin verificar reenvía el enlace.
- **Login**: `POST /api/auth/login` (tutor) o `POST /api/child/login` (niño) con rate-limit; emite la cookie de
  sesión correspondiente. El arranque de la SPA (`App.load`) prueba primero `child/me`, luego `auth/me`
  (**la sesión de niño tiene prioridad**).
- **Recuperación**: `POST /api/auth/forgot` responde siempre `{ ok: true }` (no filtra si el email existe) y, si
  existe, manda enlace `reset` (TTL 1h). `POST /api/auth/reset` fija la nueva contraseña y borra todas las
  sesiones del tutor.
- **Sesión de juego**: `GET /api/skills?profile=&course=` (exige que el niño tenga el curso) → `GET
  /api/session/next?profile=&skill=` (una plantilla del skill) → `POST /api/session/attempt` (registra intento,
  actualiza dominio, otorga monedas). El detalle de cada endpoint está en `API.md`.

## 7. Pipeline de contenido (`tools/content-gen`)

Fichero único `src/generate.ts`; corre con `node --experimental-strip-types`. Etapas **generar → validar →
empaquetar → publicar**:

1. **Generar** — `USE_MOCK = argv incluye "--mock" || no hay ANTHROPIC_API_KEY`.
   - Mock: 4 ejercicios fijos y deterministas de resta de fracciones (sin red, sin coste).
   - Claude: import dinámico del SDK; `client.messages.parse({ model: "claude-opus-4-8", thinking: adaptive,
     output_config: zodOutputFormat(Batch) })` con salida estructurada Zod.
2. **Validar** — estructura (`RawExerciseSchema`, propio del pipeline, distinto del de `packages/shared`), dedup por
   `stem` normalizado, y **auto-resolución matemática independiente** (`evalStem` resuelve `a/b ± c/d` con
   aritmética de fracciones; rechaza si la clave marcada no cuadra o si algún distractor equivale a la solución).
3. **Empaquetar** — escribe `out/<PACKAGE_ID>.json` y `out/<PACKAGE_ID>.sql`. Reproducible (`CREATED_AT` fijo).
   El `.sql` es idempotente (DELETE previos por `package_id`/`id`) e inserta `content_packages` +
   `exercise_templates` con `payload = JSON.stringify({ options, feedback })`.
4. **Publicar** — **manual**: el script solo imprime el comando `wrangler d1 execute smartkids --file=<...>.sql`.

Convención de naming del paquete: `pkg_{subject}_{gradeband}_{topic?}_v{n}` (p.ej. `pkg_math_eso5_sub_v1`).
Ojo con las tres convenciones de nivel coexistiendo: `ESO-5` (columnas), `eso5` (package_id), `ESO5` (skill_id).

**Limitaciones actuales del pipeline** (documentadas, no bugs a corregir sin pedirlo):
- `evalStem` solo entiende `a/b ± c/d`; otros formatos (p.ej. equivalencia) se rechazan por «requiere revisión humana».
- El `.sql` solo aplica limpio sobre una D1 ya sembrada (FK a `skills.id`) y sin `attempts` previos apuntando a
  las plantillas (FK inversa).
- Faltaría, para producción: validación con SymPy en sandbox, un LLM-judge de ambigüedad y revisión humana antes
  de `status = 'published'` (ver `tools/content-gen/README.md`).

## 8. Frontend — modelo mental (`apps/web`)

- **Sin router.** `App.tsx` decide por `window.location.pathname` (solo `/verify` y `/reset` son rutas físicas) y
  por **rol/estado** de sesión. Orden: cargando → niño → admin → tutor → login (`Auth`).
- **Pantallas** (`src/screens/`): `AdminPanel` (gestión de tutores), `TutorPanel` (niños, cónyuge, recompensas,
  canjes pendientes, cambio de contraseña), `KidApp` (contenedor niño: `GalaxyMap` / `Session` / `RewardShop`),
  `VerifyReset` (`VerifyPage` + `ResetPage`). `FamilyHome` y `ParentPanel` son **stubs muertos**.
- **Componentes** (`src/components/`): `Auth`, `Avatar`, `Hud`, `Icon`, `MathText`, `Orbi`, `SettingsToggle`,
  `Starfield`.
- **i18n**: `t()` para UI (diccionarios `es`/`en` inline en `i18n.ts`, con paridad de claves forzada por TS);
  `tx(LocaleText)` para contenido del servidor (vive en `api.ts`). Idioma en `localStorage.sk_lang`.
- **Tema**: `data-theme` en `<html>` + `tokens.css`; `settings.ts` persiste en `sk_theme` y aplica antes del
  primer render.
- **Diseño sin emojis**: iconos SVG (`Icon.tsx`, unión `IconName` de 23 nombres) y avatares por clave
  (`Avatar.tsx`, `avatarKeyOf` normaliza el legado emoji). Todo el color/espaciado sale de tokens.

Los gotchas concretos del frontend están en `../apps/web/CLAUDE.md`.

## 9. Datos sembrados (`apps/api/seed.sql`)

Idempotente (borra las 20 tablas en orden inverso y reinserta). Siembra: asignatura `math`; curso
`course_math_eso5`; 4 skills de fracciones (EQUIV→CMP→ADD→SUB) con prerrequisitos; paquete `pkg_math_eso5_v1` con
3 plantillas `multiple_choice`; progreso demo; monedero con `balance = 340`; 3 recompensas del sistema
(sin `owner_id`). **Credenciales demo:**

| Rol | Login | Password/PIN |
|---|---|---|
| admin | `admin@smartkids.dev` | `admin1234` |
| tutor | `demo@smartkids.dev` | `demo1234` |
| niña | usuario `lucia` (curso Matemáticas · 5º ESO) | PIN `1234` |

Nota: el seed **no** crea filas en `child_rewards`, así que la niña demo no tiene recompensas asignadas hasta que
un tutor se las asigne (la comprobación de asignación lo exige para canjear).
