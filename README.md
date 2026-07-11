# smartkids · Órbita

Plataforma de ejercicios educativos con recompensas (tipo Smartick), con contenido
generado por IA. Dirección visual **«Órbita»**: mundo espacial oscuro con neón, el
progreso como una galaxia de planetas y una mascota-guía (**Orbi**).

## Stack

- **Frontend:** React + Vite + TypeScript, PWA → Cloudflare Pages
- **Backend:** Hono sobre Cloudflare Workers (edge) → binding D1
- **Datos:** Cloudflare D1 (SQLite) + KV + R2 (egress 0)
- **Contenido:** pipeline offline con la Claude API (generar → validar → empaquetar → publicar)

## Monorepo (pnpm workspaces)

```
apps/
  web/          SPA React + Vite (PWA)  ·  Cloudflare Pages
  api/          Hono en Cloudflare Workers  ·  binding D1
packages/
  shared/       tipos + esquemas Zod compartidos
tools/
  content-gen/  pipeline offline de generación de contenido (esqueleto)
```

## Desarrollo local (100% offline, sin nube)

Requisitos: **Node ≥ 22** y **pnpm** (via `corepack enable`).

```bash
pnpm install
pnpm dev          # levanta web (5173) + api (8787) en paralelo
```

- Web: http://localhost:5173  (proxya `/api/*` → Worker local en 8787)
- API: http://localhost:8787/api/health

El backend corre en el **runtime real de Workers** (workerd/Miniflare) con **D1/KV/R2
locales** en `.wrangler/` — no toca la nube ni cuesta nada.

### Otros scripts

```bash
pnpm typecheck    # tsc --noEmit en todos los paquetes
pnpm build        # build de producción
pnpm format       # prettier --write
```

## Notas

- La base de datos D1 real se crea con `wrangler d1 create smartkids` y su `database_id`
  se pone en `apps/api/wrangler.toml`. Para desarrollo local no hace falta.
- Identidad git de este repo configurada **local** (cuenta personal), no global.
