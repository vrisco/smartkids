# @smartkids/content-gen

Pipeline **offline / por lotes** de generación de contenido educativo.

Flujo (ver documento de arquitectura):

1. **Generar** — Claude (`claude-opus-4-8`) con **adaptive thinking** y **salida estructurada**
   (`output_config.format` + Zod). Modo `--mock` determinista para pruebas sin coste.
2. **Validar** — estructural (Zod) → invariantes lógicas (1 sola correcta) →
   **auto-resolución matemática independiente** (aritmética de fracciones) → dedup.
3. **Empaquetar** — paquete versionado inmutable (`package_id` + versión), como `.json` y `.sql`.
4. **Publicar** — aplicar el `.sql` a D1.

## Uso

```bash
# Genera (usa Claude si ANTHROPIC_API_KEY está definido; si no, modo mock)
pnpm --filter @smartkids/content-gen run generate

# Fuerza el modo mock (determinista, sin llamadas a la API)
pnpm --filter @smartkids/content-gen run generate -- --mock

# Publica el paquete generado en la D1 local
pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local \
  --file=tools/content-gen/out/pkg_math_eso5_sub_v1.sql
```

Los artefactos generados van a `out/` (ignorada por git). El lote de ejemplo produce
ejercicios de **resta de fracciones** (`MATH.ESO5.FRAC.SUB`), que el seed deja sin contenido.

> Producción: la validación matemática robusta debería usar **SymPy** (en un sandbox), un
> **LLM-judge** para ambigüedad/distractores y **revisión humana** antes de `published`.
