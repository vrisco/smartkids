# ADR 0004 — Puntos por skill configurables + anti-farm atómico

**Estado:** Aceptado (2026-07-12, M9)

## Contexto

Las monedas por acierto eran una constante global (`COINS_PER_CORRECT = 10`). El tutor quería fijar los **puntos
por acierto por contenido** (una ficha vale más que otra). Además, el anti-farm ("las monedas solo se conceden la
primera vez que se acierta un ejercicio") era un **read-check-insert** (SELECT de intento previo → INSERT) con una
**carrera**: dos `POST /api/session/attempt` simultáneos para la misma plantilla leían ambos "no ganado" y
**duplicaban** monedas. En Cloudflare Workers + D1 no hay transacciones reales; el niño autenticado conoce la
respuesta correcta y puede disparar N peticiones en paralelo.

## Decisión

- **Puntos por skill:** columna `skills.coins_per_correct` (nullable). El `attempt` otorga ese valor, o el global
  `COINS_PER_CORRECT` si es null. El import lo acota a un entero 1..1000 (el endpoint es privilegiado pero no de fiar
  ciegamente); el formulario del tutor ofrece 5/10/20.
- **Anti-farm ATÓMICO:** nueva tabla `coin_awards` con **PK compuesta** `(profile_id, exercise_template_id)`. El
  `attempt` intenta `INSERT ... ON CONFLICT DO NOTHING RETURNING`: solo concede monedas si el INSERT devolvió fila
  (fue la primera vez). La unicidad de la PK serializa el "cobrar una vez" sin transacción.

## Consecuencias

- (+) Elimina la carrera: N peticiones concurrentes solo cobran una vez (la PK lo garantiza a nivel de BD).
- (+) La economía por contenido es flexible sin tocar el motor.
- (−) Una fila más por (niño, ejercicio-acertado); y `coin_awards` tiene FK a `exercise_templates`, así que
      re-importar un paquete cuyas plantillas ya se acertaron chocaría con la FK al borrarlas (igual que `attempts`;
      en la práctica se re-importa antes de que se juegue).
- (−) El grading sigue siendo la fuente de verdad del acierto (ADR 0001); `coin_awards` solo gobierna el PAGO, no
      la corrección ni el progreso (`skill_progress` se actualiza en cada intento).

Verificado en runtime: 1er acierto concede; 2º acierto del mismo ejercicio concede 0.
