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

# 4) Crear la cuenta de admin (no hay registro público: el admin da de alta a los tutores)
pnpm --filter @smartkids/api run admin -- create admin@tudominio.com "<password-largo>" --remote

# 5) Publicar el curso en remoto (contenido real, versionado en content/)
pnpm --filter @smartkids/content-gen run build:course -- --course ../../content/math-eso2-operaciones
pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --remote --file=../../tools/content-gen/out/course_math_eso2_oper.sql
#   (la ruta es relativa a apps/api porque --filter ejecuta ahi; build:course imprime la ruta absoluta)

# 6) Build de la web + deploy del Worker (sirve SPA + API)
pnpm run deploy
#   -> imprime la URL:  https://app.<tu-subdominio>.workers.dev
```

Abre esa URL: verás la app «Órbita» hablando con su API, en producción.

## Entorno de pruebas (staging)

Existe para que probar deje de significar tocar la base donde estan los intentos y las
monedas de un nino real. Vive en `https://app-staging.smartkids.workers.dev`, con base de
datos y bucket propios.

```bash
pnpm run db:migrate:staging   # migra la D1 de pruebas
pnpm run db:seed:staging      # datos demo: aqui SI es seguro sembrar
pnpm run deploy:staging       # build de la web + deploy del Worker de pruebas
```

Diferencias deliberadas con produccion, todas en `apps/api/wrangler.toml`:

| | Produccion | Pruebas |
|---|---|---|
| Dominio | `app.smart-kids.uk` | `workers.dev`, **`routes = []`** |
| Cron de engagement | 17:00 diario | **ninguno** |
| `RESEND_API_KEY` | configurado | **ausente**: el email cae a modo simulado |
| `EMAIL_DEV_LINKS` | jamas | `true` |
| Datos | reales | seed demo |

> El `routes = []` de staging **no es opcional**: sin el, el entorno de pruebas hereda las
> rutas del bloque principal y se lleva el dominio `app.smart-kids.uk`, dejando la app real
> fuera de servicio en cuanto se despliegue. Comprueba siempre con `--dry-run` antes de
> desplegar un entorno nuevo; ese aviso solo sale ahi.

> Y la razon de fondo de separar entornos es la clave de Resend: sin ella, un correo de
> prueba no puede llegar nunca al buzon de una familia real.

## Actualizar un despliegue existente

Los pasos de arriba son el **alta inicial**. Para actualizar una instalacion que ya funciona, el
orden es OBLIGATORIO y en este sentido:

```bash
# 1) PRIMERO las migraciones. `pnpm run deploy` NO las aplica.
pnpm run db:migrate:remote

# 2) Y DESPUES el codigo.
pnpm run deploy
```

> **Desplegar sin migrar rompe produccion.** El Worker nuevo consulta columnas que la migracion
> aun no ha creado y la sesion de ejercicios responde 500 (`no such column: ...`) a los ninos que
> esten jugando. Si dudas de en que estado esta la base, compruebalo antes:
>
> ```bash
> pnpm --filter @smartkids/api exec wrangler d1 migrations list smartkids --remote
> ```
>
> El orden inverso (codigo antes que esquema) solo es seguro cuando el cambio de esquema es
> puramente aditivo Y el codigo nuevo no lee todavia lo que anade. No lo asumas: migra primero.

> **NO siembres producción.** `apps/api/seed.sql` es un fichero de DESARROLLO: borra las 27
> tablas y crea cuentas demo cuyas contraseñas están publicadas en este repositorio
> (`admin@smartkids.dev` / `admin1234`, `demo@smartkids.dev` / `demo1234`, PIN `1234`).
> Aplicado a la base real destruye el progreso de niños reales y reinstala credenciales
> conocidas. Por eso ya no existe el script `db:seed:remote`: el seed solo corre en local con
> `pnpm --filter @smartkids/api run db:seed`.

## Actualizar el contenido de un curso

Edita el JSON del módulo en `content/<curso>/` y repite el paso 5. La publicación es
**idempotente**: hace UPSERT por id y retira lo que ya no viene en el lote, así que puedes
republicar tantas veces como haga falta aunque los niños ya hayan respondido esos ejercicios.

## Notas

- **Admin (bootstrap):** crea/resetea el usuario admin con la CLI:
  `pnpm --filter @smartkids/api run admin -- create admin@tudominio.com <password> --remote`
  (o `reset` para cambiar la contraseña). El admin da de alta tutores; no hay registro público.
  Usa un correo propio, **no** `admin@smartkids.dev`: ese es el de las cuentas demo del seed.
- **Email real (recuperación/verificación):** configura Resend como secretos:
  `wrangler secret put RESEND_API_KEY` y `wrangler secret put EMAIL_FROM`.
- **Resto de secretos:** `CONTENT_IMPORT_TOKEN` (import de contenido) y `VAPID_PRIVATE_JWK`
  (Web Push; sin él las notificaciones se descartan en silencio). `EMAIL_DEV_LINKS` **jamás**
  debe valer `true` en producción.
- **Dominio propio:** en el dashboard de Cloudflare (Workers → app → Settings →
  Domains & Routes) puedes añadir un dominio o subdominio custom.
- **Desarrollo local** sigue igual: `pnpm dev` (web en 5173 + API en 8787). El binding de
  assets apunta a `apps/web/dist`; si haces un clon nuevo, ejecuta una vez
  `pnpm --filter @smartkids/web run build` antes del primer `wrangler dev`.
- **Coste:** Workers free = 100.000 req/día; D1 free = 5 GB. Los assets estáticos no
  cuentan como requests de Worker.
