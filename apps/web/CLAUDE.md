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

- **CERO emojis.** Iconos SVG vía `components/Icon.tsx` (unión cerrada `IconName`). Al añadir un icono, amplía
  `IconName`; no metas glifos emoji en la UI.
- **Personaje del niño** (avatar y compañero de viaje, `components/Mascot.tsx`): Orbi y animales con su mismo traje de astronauta, casco de
  cristal y antena. `<Mascot />` sin `name` pinta el del niño vía `MascotContext` (lo provee `KidApp`); fuera de la
  app del niño pasa `name`. Ids de gradiente por instancia (`useId`): se pintan varios a la vez en `MascotPick`.
  Para añadir uno: clave en `MASCOT_KEYS` + `MASCOTS` de la API, dibujo en `ANIMALS`, color en `ACCENT` e i18n
  `mascot.names.*` (es/en). `<MascotAvatar>` es el busto redondo (barra superior del niño y lista del tutor).
- **Progreso del niño** (`components/KidProgress.tsx`): `ProgressLine` (aciertos con tendencia, tiempo por pregunta,
  avance) y `ReviewButton` («Repasar fallos» con sus pendientes) en las tarjetas de `KidApp` y en la cabecera de
  `GalaxyMap`. `KidApp` recarga `api.childProgress()` al volver de cada misión.
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

## Sesión del niño y contenido del hogar

- **`screens/Session.tsx`** — fases `main` → `reviewIntro` → `review` → `summary`. La longitud de la tanda la marca
  el skill (`sessionLength` que devuelve `api.nextExercise`; 5 si no viene); con más de 12 preguntas se pinta barra
  de progreso en vez de puntos. Al fallar, tarjeta con la respuesta correcta, la teoría (`theory`, «Recuerda») y
  cómo se resuelve (`solution`). Si hubo fallos, pantalla de transición y SESIÓN DE REPASO con esos mismos
  ejercicios barajados (`api.retryExercise` → `?exercise=<id>`; fallar lo reencola, tope = fallos + 3); al final,
  resumen. La corrección y las monedas siguen siendo del servidor.
- **`components/ExerciseInput.tsx`** — inputs de los 10 tipos; `multiple_select` son casillas y envía
  `{ type:"multiple_select", optionIds }`.
- **`components/ColumnOps.tsx`** — `column_operation` y `prime_factorization` «como en el cuaderno». UNA colocación
  (`layoutColumn`: cuadrícula de casillas con rayas y la «casita» de la división) en tres modos: `input` (el niño la
  hace; casillas de una cifra que avanzan solas, de derecha a izquierda en sumas/restas/multiplicaciones y de
  izquierda a derecha en el cociente; la coma se teclea en la casilla de su cifra; solo cuentan las de borde de
  color), `solved` (`WorkedOperation`: tras fallar y en la vista previa) y `paper` (`PaperOperation`, la ficha). La
  aritmética sale de `@smartkids/shared/arith` (import de RUNTIME permitido: no lleva zod). Las casillas del cociente
  son las que PUEDE tener (no chivan cuántas cifras tiene).
- **`components/Worksheet.tsx`** — «Ficha PDF» de cada contenido del hogar (botón en `TutorPanel`): el tutor elige
  tipos y nº de preguntas (tope 50; reparto por turnos entre tipos y de fácil a difícil, opciones/ítems barajados; las
  cuentas en columna salen en cuadrícula de cuaderno y la factorización con su escalera vacía) y
  se imprime con `window.print()` («Guardar como PDF»). Las soluciones van SIEMPRE al final en página aparte y son
  sencillas (solo nº y respuesta, sin explicaciones); el recuadro de operaciones es opcional.
  Sin dependencias ni endpoint nuevo: usa `api.skillExercises` (excluye los ocultos). La hoja va en un portal fuera
  de `#root` y el CSS `@media print` (`html.ws-printing`, tokens `--print-*`) oculta el resto de la app.
- **`screens/TutorPanel.tsx`** — formulario de solicitud (Vía B): nº de preguntas 10..200 con aviso del 50 % extra
  que se genera, preguntas por misión (5..30), 1..6 módulos, casillas de tipos de pregunta con presets por materia
  (`TYPE_PRESETS`) y un campo opcional «Ejemplos o guía» (`examples`, tope 4000 como la API); en modo «Regenerar» elige sustituir (`replace`) o crear uno nuevo (`copy`) y llama a
  `api.regenerateContentRequest`. Cada contenido del hogar ofrece «Regenerar» (si su solicitud está procesada) y un
  selector de preguntas por misión (`api.setSkillSessionLength`). `ExerciseReports` lista las preguntas que los niños
  han marcado como erróneas (su respuesta, la esperada y la solución) con «Ocultar pregunta» (solo contenido propio)
  y «Estaba bien».
- **`screens/Session.tsx` → `ReportQuestion`** — tras responder, «¿Crees que esta pregunta está mal?» con tres
  motivos (`api.reportExercise`).

## Gotchas / código a no imitar

- `Hud` pinta el personaje del niño (`<MascotAvatar>`); el botón sigue siendo «Cambiar de perfil». La racha es real (`streak` de `/api/child/me`).
- Curso escolar: `grades.ts` (`GRADE_BANDS`, `isGradeBand`); cualquier otro valor (el antiguo `"ESO-5"`) = sin definir.
- Inputs de texto de las respuestas: siempre con `NO_AUTOCORRECT` (`ExerciseInput.tsx`); el autocorrector del
  móvil cambiaría una respuesta mal escrita por la buena y el subrayado del corrector chivaría el error.
- `MathText` solo entiende fracciones `entero/entero` (regex `\d+/\d+`); otra notación pasa como texto plano.
- `Starfield` (canvas) lee el tema una sola vez: **no se recolorea** al conmutar tema en caliente.
- `SettingsToggle` usa estado local (sin Context): dos instancias no se sincronizarían.
- `r.icon as IconName` (RewardShop/TutorPanel) confía en que el string de BD sea un `IconName` válido; si no, el
  icono queda vacío.
- Código muerto: `screens/FamilyHome.tsx` y `screens/ParentPanel.tsx` son `export {}`; hay CSS de pantallas
  eliminadas en `app.css`/`auth.css`. No los uses de referencia.
