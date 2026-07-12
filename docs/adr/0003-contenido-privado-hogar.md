# ADR 0003 — Contenido privado del hogar

**Estado:** Aceptado (2026-07-12, M9)

## Contexto

El contenido de la Vía B (generado del material de un tutor: su libro, sus fotos) es **personal**: por privacidad
y GDPR no debe entrar en el catálogo global visible por todos los niños. Debe verlo y jugarlo **solo el niño del
tutor** (y su cónyuge co-tutor). El modelo previo solo tenía contenido global, accedido por curso (asignatura+nivel).

## Decisión

- **Propiedad:** `skills.owner_id` y `content_packages.owner_id` (null = global; set = privado del hogar del tutor).
- **Asignación:** tabla `child_skills` (niño ↔ skill privado), análoga a `child_courses`/`child_rewards`.
- **Acceso (doble comprobación):** un niño accede a un skill privado si su `owner_id` **sigue en el HOGAR** del niño
  (`householdIds`, vínculo de cónyuge SIMÉTRICO) **Y** existe el grant en `child_skills`. Lo aplican
  `childCanAttemptSkill` (juego), `GET /api/skills` (galaxia) y `GET /api/child/me` (`customContent`). El grant por
  sí solo NO basta como prueba de pertenencia.
- **Presentación:** en la app del niño, cada skill privado es una **ficha** propia (o un **path** de módulos si
  `path_id`), no se mezcla con el catálogo del curso.
- **Limpieza:** al desvincular cónyuge (`DELETE /api/tutor/spouse`) se barren los grants cruzados de recompensas
  Y de skills, para no dejar accesos huérfanos entre hogares que se separan.

## Consecuencias

- (+) Aislamiento por hogar: el material de un tutor no se filtra a otros niños.
- (+) La doble comprobación (owner-en-hogar + grant) resiste grants huérfanos: aunque quede uno, el acceso al
      contenido queda bloqueado (revalidación de hogar en los tres puntos de lectura).
- (−) Toda ruta que liste/juegue contenido debe recordar la revalidación de hogar; un `SELECT` que confíe solo en
      `child_skills` reintroduce la fuga (fue un hallazgo real de revisión; ver los `inArray(owner, household)`).
- (−) `courses` y `skills` no están unidos por FK (comparten subject+gradeBand); el contenido privado se ve en la
      galaxia del curso que coincide en asignatura+nivel, así que el tutor debe alinearlos.
