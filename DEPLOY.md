# Deploy a Cloudflare

La app se despliega como **un único Worker** que sirve la SPA (Static Assets) y la API
(`/api/*`) en el mismo origen. Datos en **D1**. Todo en free tier.

## Requisitos

- Una cuenta de **Cloudflare** (gratis: https://dash.cloudflare.com/sign-up).
- Estar autenticado con wrangler (paso 1).

## Pasos

```bash
cd smartkids

# 1) Autenticarse (abre el navegador; usa TU cuenta de Cloudflare)
pnpm --filter @smartkids/api exec wrangler login

# 2) Crear la base de datos D1 remota y copiar el database_id
pnpm --filter @smartkids/api exec wrangler d1 create smartkids
#   -> pega el "database_id" que imprime en apps/api/wrangler.toml (campo database_id)

# 3) Aplicar la migración a la D1 remota
pnpm run db:migrate:remote

# 4) Sembrar datos iniciales en remoto (mates ESO-5, perfil demo, recompensas)
pnpm run db:seed:remote

# 5) Build de la web + deploy del Worker (sirve SPA + API)
pnpm run deploy
#   -> imprime la URL:  https://app.<tu-subdominio>.workers.dev
```

Abre esa URL: verás la app «Órbita» hablando con su API, en producción.

## Publicar un paquete de contenido en remoto (opcional)

```bash
pnpm --filter @smartkids/content-gen run generate -- --mock
pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --remote \
  --file=tools/content-gen/out/pkg_math_eso5_sub_v1.sql
```

## Notas

- **Admin (bootstrap):** crea/resetea el usuario admin con la CLI:
  `pnpm --filter @smartkids/api run admin -- create admin@tudominio.com <password> --remote`.
  El admin da de alta tutores; no hay registro público.
- **Email real (recuperación/verificación):** configura Resend como secretos:
  `wrangler secret put RESEND_API_KEY` y `wrangler secret put EMAIL_FROM`.
- **Dominio propio:** en el dashboard de Cloudflare (Workers → app → Settings →
  Domains & Routes) puedes añadir un dominio o subdominio custom.
- **Desarrollo local** sigue igual: `pnpm dev` (web en 5173 + API en 8787). El binding de
  assets apunta a `apps/web/dist`; si haces un clon nuevo, ejecuta una vez
  `pnpm --filter @smartkids/web run build` antes del primer `wrangler dev`.
- **Coste:** Workers free = 100.000 req/día; D1 free = 5 GB. Los assets estáticos no
  cuentan como requests de Worker.
