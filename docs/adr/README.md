# Architecture Decision Records (ADR)

Registro de las **decisiones de arquitectura** importantes de smartkids: el PORQUÉ, no el CÓMO
(el cómo está en el código, `CLAUDE.md` y `docs/ARCHITECTURE.md`). Cada ADR es inmutable una vez
aceptado; si una decisión cambia, se añade un ADR nuevo que la supersede (no se reescribe el viejo).

Formato: Título · Estado · Contexto · Decisión · Consecuencias.

| # | Decisión | Estado |
|---|---|---|
| [0001](0001-modelo-unificado-ejercicio.md) | Modelo unificado del ejercicio (7 tipos, fuente única en `packages/shared`) | Aceptado |
| [0002](0002-generacion-contenido-dos-vias.md) | Generación de contenido en dos vías (spec-driven + material del tutor) | Aceptado |
| [0003](0003-contenido-privado-hogar.md) | Contenido privado del hogar (owner_id + child_skills + scoping) | Aceptado |
| [0004](0004-economia-anti-farm-atomico.md) | Puntos por skill + anti-farm atómico (`coin_awards`) | Aceptado |
