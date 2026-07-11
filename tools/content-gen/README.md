# @smartkids/content-gen

Pipeline **offline / por lotes** de generación de contenido educativo con la Claude API.

Flujo previsto (ver documento de arquitectura):

1. **Generar** — Claude (Opus 4.8) con salida estructurada (JSON Schema), lotes con Batch API + prompt caching.
2. **Validar** — estructural (Zod) → invariantes lógicas → **auto-resolución matemática independiente (SymPy)** → LLM-judge → dedup.
3. **Empaquetar** — paquete versionado e inmutable (`package_id` + semver).
4. **Publicar** — `draft → auto_valid → human_approved → published` en D1.

> Estado: **esqueleto**. La generación real se implementa en un hito posterior.
> Requiere `ANTHROPIC_API_KEY` en el entorno cuando se implemente.
