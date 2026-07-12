# CLAUDE.md — guía para Claude Code

Guía operativa del monorepo **smartkids** («Órbita»). Léela entera antes de tocar código.

Convenciones de escritura de este repo: **todo en español**, **sin emojis** en la UI ni en textos
(preferencia fija del usuario y política del propio proyecto). Mantén esa norma también en la doc.

**Documentación relacionada** (más detalle): `docs/ARCHITECTURE.md` (modelo de datos de 20 tablas, jerarquía de
usuarios, economía de recompensas, flujos de auth, pipeline de contenido) y `docs/API.md` (catálogo de endpoints
por rol). Hay además `CLAUDE.md` anidados en `apps/api/` y `apps/web/` con las convenciones y gotchas de cada
subsistema (se auto-cargan al trabajar en esas carpetas).

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

Hitos M1–M8 hechos (ver `git log`, Conventional Commits en español con etiqueta `— M#`). Lo más reciente:
recompensas definidas por el tutor (canjeable/objetivo) y la bandeja de **canjes pendientes** del tutor
(`grant`/`reject`) — esta última puede estar aún en el árbol de trabajo sin commitear.

Pendiente (no empieces ninguno sin confirmarlo con el usuario):
- Motor pedagógico **FSRS real** (hoy la subida/bajada de `mastery` es heurística en `POST /api/session/attempt`).
- **Generación de contenido con Claude API real** (hoy el pipeline corre en `--mock`).
- Más asignaturas, idiomas y **tipos de ejercicio** (solo 3 de los 7 enumerados tienen esquema en `packages/shared`).
- Iconos PWA (`vite.config.ts` tiene `manifest.icons: []`).

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
- Datos en **Cloudflare D1** (SQLite, `binding = DB`). **No hay KV, R2 ni Durable Objects**: todo el estado
  (sesiones, rate-limit, tokens) vive en D1.

Consecuencia clave: **el binding `ASSETS` apunta a `apps/web/dist`**. En un clon nuevo o antes del primer
`wrangler dev`/`deploy`, ejecuta `pnpm --filter @smartkids/web run build` o falla.

## 5. Modelo de datos

Drizzle sobre D1/SQLite, **20 tablas**, esquema en `apps/api/src/db/schema.ts`. La frontera está marcada con
comentarios de sección en el propio schema:

- **CONTENIDO (inmutable, versionado):** `subjects`, `skills`, `skill_prerequisites`, `content_packages`,
  `exercise_templates`. IDs semánticos estables (`MATH.ESO5.FRAC.ADD`); versionado por `content_packages.version`
  y `exercise_templates.content_version`. El contenido **nunca se muta in-place**: se publican nuevas versiones.
- **PROGRESO (mutable, por niño):** `skill_progress`, `attempts`, y la economía `wallets`, `wallet_ledger`,
  `redemptions`. Cada intento congela `content_version` para que el histórico no se corrompa si el contenido evoluciona.
- **Identidad y acceso:** `parent_accounts` (tutores/admin, `role`), `child_profiles`, `courses`,
  `child_courses` (acceso niño↔curso), `child_rewards` (acceso niño↔recompensa), `rewards`.
- **Seguridad:** `sessions` (tutor), `child_sessions` (niño), `auth_tokens` (verify/reset), `login_attempts` (rate-limit).

**Hogar / cónyuge:** `parent_accounts.spouse_id` + `spouse_pending_from`. Un tutor puede compartir TODOS sus
niños con un co-tutor. **El vínculo solo concede acceso si es SIMÉTRICO** (`A.spouse_id=B` y `B.spouse_id=A`):
`householdIds()` y `ownsProfile()` (en `apps/api/src/index.ts` / `auth.ts`) lo comprueban en ambos lados. Un
estado asimétrico nunca da acceso. La vinculación es con **consentimiento bilateral** (invitar deja pendiente
sin acceso; el invitado acepta/rechaza).

**Economía / recompensas:** `rewards.kind` = `spend` (canjeable: descuenta `wallets.balance` con decremento
atómico condicional) o `goal` (objetivo: exige N puntos GANADOS en ejercicios en una ventana; NO descuenta).
`earnedSince()` suma solo movimientos de `wallet_ledger` con `reason LIKE 'exercise:%'`. Las ventanas
(`period`, `limit_period`) son **rodantes** (`week`=7d, `month`=30d desde ahora), no de calendario.
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

## 8. Contenido (`packages/shared` + `tools/content-gen`)

- `packages/shared` (`@smartkids/shared`) exporta esquemas Zod del ejercicio (`ExerciseSchema`,
  `ExerciseType`, `LocaleText`...). Es **source-only** (se consume el `.ts`, sin build). **Aún no lo importa
  nadie** y su modelo **diverge** del que se persiste en D1 (en la BD `options`+`feedback` van en `payload` JSON).
  No lo trates como fuente de verdad del contenido almacenado sin unificarlo antes.
- `tools/content-gen` genera → valida → empaqueta → publica. **Modo mock por defecto** (si pasas `--mock` o si
  no hay `ANTHROPIC_API_KEY`); con key usa **Claude `claude-opus-4-8`** con salida estructurada Zod. Valida la
  aritmética de fracciones de forma independiente (`evalStem`) y rechaza distractores equivalentes a la solución.
  Escribe `out/pkg_..._v1.json` + `.sql` (**`out/` está gitignored**). **No publica**: aplica el `.sql` a D1 a mano.
  El `.sql` solo aplica limpio sobre una D1 ya sembrada con `seed.sql` (FK a `skills.id`).

## 9. Deploy e infraestructura

Todo Cloudflare, free tier (ver `DEPLOY.md`). Config en `apps/api/wrangler.toml`:
- Worker `app`, `compatibility_date = 2026-07-01`, dominio custom `app.smart-kids.uk`.
- D1 `smartkids` con `database_id` **real ya commiteado** en el toml (no es secreto; en local no se usa).
- **Secrets de producción por `wrangler secret put`** (no en el toml ni en `.dev.vars`):
  `RESEND_API_KEY`, `EMAIL_FROM`. En local, `.dev.vars` (gitignored) define solo `EMAIL_DEV_LINKS=true`.
- Migrar/sembrar **producción**: `pnpm db:migrate:remote` / `pnpm db:seed:remote` (tocan datos reales, cuidado).
  Los scripts `db:migrate`/`db:seed` del paquete api son **solo `--local`**.

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
- **No confíes en `POST /api/session/attempt` como fuente de verdad de aciertos**: hoy otorga monedas según el
  `correct` que afirma el cliente y no valida que el skill/plantilla pertenezcan a un curso del niño. Documentado, no lo empeores.
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
| Modelo del ejercicio (Zod) | `packages/shared/src/exercise.ts` |
| Pipeline de contenido | `tools/content-gen/src/generate.ts` |
| Cómo desplegar | `DEPLOY.md` |
| Modelo de datos a fondo (20 tablas, auth, economía) | `docs/ARCHITECTURE.md` |
| Catálogo de endpoints por rol | `docs/API.md` |
| Convenciones y gotchas del backend | `apps/api/CLAUDE.md` |
| Convenciones y gotchas del frontend | `apps/web/CLAUDE.md` |
