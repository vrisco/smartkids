# CLAUDE.md — frontend (`apps/web`, `@smartkids/web`)

SPA React 19 + Vite 6 + PWA, diseño «Órbita». Se sirve como Static Assets desde el mismo Worker que la API.
Guía global en `../../CLAUDE.md`; modelo mental del frontend en `../../docs/ARCHITECTURE.md` (§8).

## Estructura

- `src/main.tsx` — bootstrap: importa `./i18n`, los 4 CSS en orden (`tokens` → `global` → `app` → `auth`),
  aplica el tema antes del primer render y monta `<App/>`.
- `src/App.tsx` — **enrutado por rol/estado** (ver abajo).
- `src/api.ts` — cliente `fetch` de la API + tipos + el helper `tx()` (contenido i18n del servidor).
- `src/i18n.ts` — i18next; diccionarios `es`/`en` inline.
- `src/settings.ts` — tema (`getTheme`/`setTheme`/`applyTheme`).
- `src/screens/` — pantallas. `src/components/` — reutilizables. `src/styles/` — CSS (empieza por `tokens.css`).

## Comandos

```bash
pnpm --filter @smartkids/web run dev        # vite :5173, proxy /api → :8787
pnpm --filter @smartkids/web run build      # vite build → dist/ (lo sirve el Worker)
pnpm --filter @smartkids/web run typecheck  # tsc --noEmit
```

## Enrutado (no hay router)

Solo `/`, `/verify` y `/reset` son rutas físicas (por `window.location.pathname` en `App.tsx`). El resto es
render condicional por sesión, en este orden: cargando → **niño** (`KidApp`) → **admin** (`AdminPanel`) →
**tutor** (`TutorPanel`) → login (`Auth`). La sesión de niño tiene prioridad. La navegación interna de `KidApp`
(`map`/`session`/`reward`) es estado local: no es URL-addressable ni compatible con el botón atrás.

## Reglas de diseño (preferencias fijas del usuario)

- **CERO emojis.** Iconos SVG vía `components/Icon.tsx` (unión cerrada `IconName`, 23 nombres); avatares vía
  `components/Avatar.tsx` (claves `orbi/fox/panda/octo/unicorn/frog/tiger/robot`; `avatarKeyOf` normaliza el
  legado emoji). Al añadir un icono, amplía `IconName`; no metas glifos emoji en la UI.
- **Solo tokens de diseño.** Todo color/espaciado sale de `styles/tokens.css` (`var(--...)`), nunca colores
  sueltos. Botones de **altura uniforme** (`--btn-h`, `--btn-h-sm`); usa `.btn-primary` / `.btn-ghost` /
  `.btn-danger` y el modificador `.sm`. Escala de espaciado `--sp-1..--sp-8` (la UI debe «respirar»).
- **Responsive de verdad.** Base móvil; breakpoints `@media (min-width:760px)` y `1080px`. `.app-shell` se ensancha.
- **Tema claro/oscuro.** `data-theme` en `<html>` + `settings.ts` (persistido en `sk_theme`). Los valores del tema
  oscuro están **duplicados** en `tokens.css` (bloque `@media prefers-color-scheme:dark` y bloque
  `[data-theme="dark"]`): al cambiar la paleta oscura, **edita los dos**.
- **i18n ES/EN.** `t()` para textos de UI (paridad de claves forzada por TS entre `es` y `en` en `i18n.ts`).
  Para nombres de contenido del servidor (`LocaleText`: skills/cursos/recompensas) usa `tx()` — **está en
  `api.ts`, no en `i18n.ts`**. Idioma en `localStorage.sk_lang`.

## Cliente API

`src/api.ts` usa rutas **relativas** `/api/...` y cookies de mismo origen (**sin `credentials:"include"`**). En dev
funciona por el proxy de Vite; en prod por mismo origen. Un despliegue cross-origin rompería la sesión. Errores:
`j<T>()` lanza `Error(message)`; cada pantalla hace `try/catch` y muestra `e.message` (varias listas degradan a `[]`).

## Gotchas / código a no imitar

- `Hud` pinta la **inicial** del nombre (no el `<Avatar>` SVG) y la racha está **hardcodeada a `7`**.
- `gradeBand` se fija a `"ESO-5"` al crear niño en `TutorPanel.ChildForm`.
- `MathText` solo entiende fracciones `entero/entero` (regex `\d+/\d+`); otra notación pasa como texto plano.
- `Starfield` (canvas) lee el tema una sola vez: **no se recolorea** al conmutar tema en caliente.
- `SettingsToggle` usa estado local (sin Context): dos instancias no se sincronizarían.
- `r.icon as IconName` (RewardShop/TutorPanel) confía en que el string de BD sea un `IconName` válido; si no, el
  icono queda vacío.
- Código muerto: `screens/FamilyHome.tsx` y `screens/ParentPanel.tsx` son `export {}`; hay CSS de pantallas
  eliminadas en `app.css`/`auth.css`. No los uses de referencia.
- Credenciales demo hardcodeadas en el JSX de `Auth.tsx` (visibles en el bundle). PWA sin iconos
  (`vite.config.ts` → `manifest.icons: []`, TODO pendiente).
