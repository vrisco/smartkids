# ADR 0002 — Generación de contenido en dos vías

**Estado:** Aceptado (2026-07-12, M9)

## Contexto

El contenido se generaba con un pipeline offline HARDCODEADO (una asignatura, un tipo, prompt fijo, publicación
a mano aplicando un `.sql`). Se querían dos flujos distintos:
- (A) Que el desarrollador/usuario generase contenido para el **catálogo global** describiéndolo en lenguaje natural.
- (B) Que un **tutor** subiera material (fotos de un libro, PDF, texto) o una descripción por la app y se le
  generaran ejercicios **para su hijo**, avisándole cuando estuvieran listos.

Restricción del entorno: no hay `ANTHROPIC_API_KEY` disponible siempre; la generación real (Claude) es opcional.

## Decisión

**Dos vías, orquestadas por una skill del proyecto** (`.claude/skills/smartkids_content/`):

- **Vía A (catálogo global):** `tools/content-gen` reescrito **spec-driven** y multi-tipo. Lee una spec JSON
  (asignatura/nivel/skill/tipos/count/dificultad/instrucciones), genera con Claude (`claude-opus-4-8`, salida Zod)
  o en `--mock`, valida con `validateExercise`, y emite `out/<pkg>.json`+`.sql`. Se publica con `wrangler d1 execute`.
- **Vía B (privado del hogar):** el tutor sube material y config por la app → `POST /api/tutor/content-requests`
  (multipart, ficheros a **R2**) crea una `content_requests`. La skill lista las pendientes, descarga los assets,
  genera (multimodal si hay API key; si no, extrae texto del PDF y redacta), y **publica vía API**:
  `POST /api/admin/content/import` (auth Bearer `CONTENT_IMPORT_TOKEN` o admin) inserta el contenido privado, lo
  asigna al niño y **envía el email** de aviso al tutor.

Alta latitud humana: la skill es una GUÍA para Claude Code (que hace de generador/validador), no un servicio.

## Consecuencias

- (+) Vía A encaja con el modelo de contenido inmutable/versionado (SQL directo, sin API nueva).
- (+) Vía B necesita estado servidor (job + assets + notificación), y por eso tiene su propio endpoint de import,
      que además centraliza validación, asignación y email.
- (+) Sin `ANTHROPIC_API_KEY` el sistema sigue siendo usable (mock en A; extracción de texto en B).
- (−) La Vía B "que ve" las figuras de un PDF necesita la API multimodal (con key); sin ella, solo el texto.
- (−) La skill vive en el repo pero Claude Code solo la descubre si el workspace se abre EN `smartkids/` (o con
      una copia personal en `~/.claude/skills/`). Documentado en `CLAUDE.md` §8.
- Idempotencia: el import borra+reinserta las plantillas del paquete; re-lanzarlo es seguro (y reenvía el email).
