# API de smartkids

> **Nota (M9):** este catálogo no incluye los endpoints del sistema de contenido: `/api/session/*` (endurecidos),
> `/api/admin/content/import`, `/api/tutor/content`, `/api/tutor/skills/:id/assign` + `DELETE`,
> `/api/tutor/content-requests` (GET/POST/PATCH-editar/DELETE + assets). Para el catálogo vivo, lee las rutas en
> `apps/api/src/index.ts`; la visión de conjunto está en `../CLAUDE.md` §8.

Catálogo de todos los endpoints del Worker (`apps/api/src/index.ts`). Todos cuelgan de `/api/*` y responden JSON.
El cliente de la SPA que los consume está en `apps/web/src/api.ts`.

## Autorización — guards

No hay middleware global: **cada handler llama a su guard a mano** y hace `if (typeof x !== "string") return x;`.

| Guard | Regla | Error |
|---|---|---|
| `requireParent` | hay sesión de tutor/admin (`sk_session`) | 401 |
| `requireAdmin` | sesión + `role = 'admin'` | 401 / 403 |
| `childOrOwner(childId)` | el propio niño (`sk_child`) **o** el tutor con `ownsProfile` | 401 / 403 |
| `ownsProfile(parentId, childId)` | el niño es del tutor o de su cónyuge con vínculo **simétrico** | — |
| `householdIds(parentId)` | `[parentId (+ spouseId si simétrico)]` — base de las consultas «del hogar» | — |

Notas:
- `/api/tutor/*` usan `requireParent` y **no** exigen rol tutor (un admin con sesión también pasa), salvo
  `POST /api/tutor/spouse`, que sí comprueba `role = 'tutor'`.
- `/api/auth/me`, `/api/auth/resend-verification` y `/api/auth/change-password` hacen su propio check 401 en vez de `requireParent`.

## Público (sin sesión)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/health` | `{ ok, service, ts }`. |
| POST | `/api/auth/login` | Login tutor/admin (email+password). Rate-limit por IP y email. Emite `sk_session`. |
| POST | `/api/auth/logout` | Destruye la sesión de tutor. |
| POST | `/api/auth/verify` | Consume token `verify` → `email_verified = true`. |
| POST | `/api/auth/forgot` | Recuperación: manda enlace `reset` (TTL 1h) si el email existe. Respuesta uniforme (no filtra existencia). Rate-limit por IP. |
| POST | `/api/auth/reset` | Consume token `reset`, fija password (mín. 6), marca email verificado, borra sesiones del tutor. |
| POST | `/api/child/login` | Login de niño (`username`+`pin`). Rate-limit por IP y usuario. Emite `sk_child`. Devuelve niño + cursos. |
| POST | `/api/child/logout` | Destruye la sesión de niño. |

## Sesión de tutor (`requireParent`)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/auth/me` | Tutor + cónyuge + invitaciones de cónyuge (entrante/saliente) + niños del hogar. |
| POST | `/api/auth/resend-verification` | Reenvía el email de verificación (o `{ alreadyVerified: true }`). |
| POST | `/api/auth/change-password` | Cambia password validando la actual (nueva mín. 6). |
| GET | `/api/courses` | Lista todos los cursos. |
| POST | `/api/tutor/spouse` | Invita a un cónyuge/co-tutor (queda pendiente, sin acceso). Rate-limit. Exige `role = 'tutor'`. |
| POST | `/api/tutor/spouse/accept` | Acepta la invitación entrante; escribe el vínculo simétrico con `db.batch` + verificación. |
| POST | `/api/tutor/spouse/reject` | Rechaza la invitación entrante. |
| DELETE | `/api/tutor/spouse` | Desvincula (ambos lados si simétrico) y barre `child_rewards` cruzados. |
| POST | `/api/profiles` | Crea un niño (valida `username` con `USERNAME_RE`, PIN 4+), crea wallet, asigna cursos válidos. |
| POST | `/api/profiles/:id/update` | Actualiza niño (nombre/avatar/pin/username). Requiere `ownsProfile`. |
| DELETE | `/api/profiles/:id` | Borra niño en cascada (`deleteChildCascade`). Requiere `ownsProfile`. |
| POST | `/api/profiles/:id/courses` | Reemplaza el set de cursos del niño. Requiere `ownsProfile`. |
| GET | `/api/tutor/rewards` | Recompensas del hogar con sus `childIds` asignados. |
| POST | `/api/tutor/rewards` | Crea recompensa (`kind`, `period`, `limitCount`/`limitPeriod`) y la asigna a niños válidos. |
| PATCH | `/api/tutor/rewards/:id` | Edita recompensa del hogar. |
| DELETE | `/api/tutor/rewards/:id` | Borra recompensa del hogar en cascada (`deleteRewardCascade`). |
| GET | `/api/tutor/redemptions` | Canjes `pending` de los niños del hogar. |
| POST | `/api/tutor/redemptions/:id/grant` | Marca el canje como `granted`. Exige `ownsProfile` del niño. |
| POST | `/api/tutor/redemptions/:id/reject` | Marca `rejected`; si era `spend` reembolsa los puntos. |

Nota: `/api/tutor/redemptions*` es la funcionalidad más reciente (bandeja de aprobación familiar); puede estar
en el árbol de trabajo sin commitear según el momento.

## Solo admin (`requireAdmin`)

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/admin/tutors` | Da de alta un tutor (password aleatoria) + invitación por email. Idempotente (reinvita si sigue sin verificar). |
| GET | `/api/admin/tutors` | Lista tutores. |
| POST | `/api/admin/tutors/:id/reset-password` | Cierra sesiones del tutor y le manda enlace de reset (TTL 24h). |
| DELETE | `/api/admin/tutors/:id` | Borra tutor; si tiene cónyuge reasigna niños/recompensas a él, si no borra en cascada. |

## Niño o tutor dueño (`childOrOwner`)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/child/me` | Niño logado + balance + cursos. |
| GET | `/api/profiles/:id` | Perfil del niño + balance del wallet. |
| GET | `/api/profiles/:id/courses` | Cursos del niño. |
| GET | `/api/skills?profile=&course=` | Skills del curso (join con `skill_progress`). Exige `hasCourse` o 403 `no_course_access`. |
| GET | `/api/session/next?profile=&skill=` | Una `exercise_template` aleatoria del skill (default `MATH.ESO5.FRAC.ADD`). |
| POST | `/api/session/attempt` | Registra intento, actualiza `skill_progress`, otorga 10 monedas si `correct`, escribe `wallet_ledger`. |
| GET | `/api/rewards` | Niño: recompensas asignadas del hogar con `progress`/`claimable`/`redeemedInWindow`. Tutor: recompensas del hogar. |
| POST | `/api/rewards/:id/redeem` | Canjea recompensa asignada del hogar. `goal` exige puntos ganados (no descuenta); `spend` descuenta el wallet atómicamente. |

## Fallbacks

| Método | Ruta | Qué hace |
|---|---|---|
| ALL | `/api/*` | 404 `{ error: "not found" }` (cualquier ruta de API no definida). |
| ALL | `*` | `ASSETS.fetch(...)` → sirve la SPA. |

## Códigos de error frecuentes

`401 unauthorized`, `403 forbidden` / `no_course_access`, `404 not_found`, `409 email_taken` / `username_taken` /
`already_linked` / `limit_reached` / `conflict`, `429 rate_limited`, `400 invalid` / `insufficient_funds` /
`goal_not_reached` / `invalid_token`.
