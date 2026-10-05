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

## Cursos fijos (Vía C): `build:course`

Los cursos redactados a mano viven en `content/<curso>/` (en git): `course.json` con la lista ordenada de módulos
y un `NN-<slug>.json` por módulo (`{ skill, exercises }`). El builder valida cada ejercicio con el modelo de
`packages/shared` y emite UN `.sql` idempotente en `out/<courseId>.sql`:

```bash
pnpm --filter @smartkids/content-gen run build:course -- --course content/math-pri6-calculo
pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local --file=tools/content-gen/out/course_math_pri6_calculo.sql
```

**Documentos de estudio del curso** (opcional): `content/<curso>/docs/NN-<slug>.<tipo>.json` con
`{ "module"?: "<fichero del módulo>", "position"?: n, "childAnswers"?: bool, "id"?: "...", "doc": { ... } }`, donde
`doc` sigue `StudyDocSchema` (`packages/shared/src/studydoc.ts`) y `<tipo>` = `doc.kind`. El builder los valida
(`validateStudyDoc`, y muestra los avisos de `lintStudyDoc`) y los añade al mismo `.sql`: UPSERT por id (la versión
solo sube si cambia el contenido; `hidden` y `child_answers` no se pisan; el `WHERE owner_id IS NULL` impide
convertir en global un documento privado con el mismo id) y retirada de los del curso que ya no están en `docs/`.
Si el id no viene, se forma como `doc_<courseId>_<nombre del fichero sin .json>`. Ejemplos en `content/math-pri6-calculo/docs/`.
