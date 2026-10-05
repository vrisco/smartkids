# CLAUDE.md — frontend (`apps/web`, `@smartkids/web`)

SPA React 19 + Vite 6 + PWA, diseño «Órbita». Se sirve como Static Assets desde el mismo Worker que la API.
Guía global en `../../CLAUDE.md`; modelo mental del frontend en `../../docs/ARCHITECTURE.md` (§8).

## Estructura

- `src/main.tsx` — bootstrap: importa `./i18n`, los 6 CSS en orden (`tokens` → `global` → `app` → `auth` →
  `print` → `studydoc`), aplica el tema antes del primer render y monta `<App/>`.
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
pnpm --filter @smartkids/web run test       # pruebas puras de la impresión (test/print.test.ts)
node apps/web/scripts/print-check.mjs       # con `dev` arrancado: PDF de print-demo.html en .print-out/
```

`print-demo.html` + `src/dev/PrintDemo.tsx` son SOLO de desarrollo (no entran en `dist/`): pintan cada ficha, examen,
tarjeta y documento con fixtures de las cinco materias (`?view=sheet|cards|worked|remember|doc`, `subject`,
`grade`, `mode`, `doc`, `screen=1`, `dark=1`...). `print-check.mjs` los pasa a PDF con Chrome sin interfaz (perfil
propio, espera a que el fichero deje de crecer) y comprueba el nº de páginas de los casos que lo garantizan.

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
- **`components/print/`** — motor de impresión (sustituye a la antigua `Worksheet.tsx`). `PrintDialog.tsx` es el
  constructor «Imprimir»: fuentes skill / path / curso del catálogo / fallos pendientes de un niño; modos práctica,
  examen, repaso de fallos, cálculo rápido, tarjetas, ejemplos resueltos y hoja «Recuerda»; opciones guardadas en
  `localStorage` (siempre en `try/catch`). Módulos PUROS (sin React, con pruebas en `test/print.test.ts`):
  `profiles.ts` (familia de la materia × edad → letra, cuadrícula, renglón, casilla de las cuentas, espacio de
  trabajo y huecos de tres anchos fijos), `select.ts` (azar con semilla, reparto 30/50/20 por dificultad y por
  turnos entre tipos, primero lo no impreso, versión B, historial), `scoring.ts` (puntos que suman 10 exactos y
  tiempo sugerido), `fromExercises.ts` (tarjetas, ejemplos resueltos y hoja «Recuerda» a partir de los ejercicios) y
  `page.ts` (`@page` con el título escapado). Piezas del papel en `paper.tsx`, preguntas en `ExercisePaper.tsx`,
  hojas en `sheets.tsx`; `PrintShell.tsx` = `usePrintJob` (UN nodo `.ws-print-root` bajo `body`, `html.ws-printing`,
  `print()` dentro del clic por Safari, título del PDF y `afterprint`). Las soluciones van SIEMPRE al final y en
  página aparte; la clave explicada enseña cada «Recuerda» solo la primera vez.
- **Papel con el tema oscuro:** dentro de `.ws-sheet` y `.sd.paper`, `print.css` remapea los tokens de pantalla
  (`--text`, `--green`...) a tinta (`--print-*`), así que `MathText`, `WorkedOperation` y las figuras salen negras
  sobre blanco. En el papel usa SOLO `--print-*`.
- **`components/studydoc/`** — `StudyDocView` pinta un documento de estudio con `medium="screen" | "paper"` (un
  renderer por bloque; en papel, el dictado lleva página para el adulto y hoja pautada para el niño, las preguntas
  van a una clave final y las tablas repiten cabecera), `FlashcardDeck` (tarjetas que se giran, con teclado y
  movimiento reducido), `StudyDocModal` (vista del tutor con imprimir) y `kinds.ts` (icono y etiqueta por tipo). La
  clase del artículo es `sd-k-<kind>` (con `sd-<kind>` chocaba con la de los bloques: `sd-timeline`).
- **`components/Txt.tsx`** — texto con notación: `rich` (documentos: `**negrita**` y matemáticas solo en `$...$`),
  `math` (ejercicios de matemáticas y ciencias, con `MathText`) y `plain` (lengua, idiomas y sociales: `MathText`
  convertiría «y/o» en fracción y pondría en cursiva la «I» inglesa).
- **`components/KidNotes.tsx`** — «Apuntes» del niño: `NotesSection` (agrupada por path / ficha / curso con
  `groupNotes`), `NotesStrip` («Apuntes de este tema» en la galaxia y en el path, hueco `notes` de `GalaxyMap`) y
  `NotesReader` (pantalla completa, A−/A+, tarjetas interactivas y «Ver solución»).
- **`screens/TutorPanel.tsx`** — formulario de solicitud (Vía B): asignatura (`subjectId`), «¿Qué quieres generar?»
  (`outputs`: ejercicios y/o documentos; por defecto ejercicios + resumen + hoja de trucos; los presets por materia
  marcan tipos de pregunta Y documentos sugeridos), nº de preguntas 10..200 con aviso del 50 % extra que se genera,
  preguntas por misión (5..30), 1..6 módulos, casillas de tipos de pregunta con presets por materia
  (`TYPE_PRESETS`) y un campo opcional «Ejemplos o guía» (`examples`, tope 4000 como la API); en modo «Regenerar» elige sustituir (`replace`) o crear uno nuevo (`copy`) y llama a
  `api.regenerateContentRequest`. Los paths salen en UNA fila plegable («N módulos · M ejercicios») con acciones
  del path entero; cada contenido tiene Vista previa, Imprimir y «Documentos (N)» (ver, imprimir, ocultar,
  respuestas para el niño, eliminar), y hay un grupo «Cursos del catálogo» con los cursos de los niños. Cada
  contenido del hogar ofrece «Regenerar» (si su solicitud está procesada) y un
  selector de preguntas por misión (`api.setSkillSessionLength`). En las estadísticas del niño, «Imprimir repaso de
  fallos». `ExerciseReports` lista las preguntas que los niños
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
