import { sqliteTable, text, integer, real, primaryKey, uniqueIndex, index } from "drizzle-orm/sqlite-core";

type LocaleText = Record<string, string>;

/* ---------- Identidad ---------- */

export const parentAccounts = sqliteTable("parent_accounts", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  role: text("role").notNull().default("tutor"), // 'admin' | 'tutor'
  spouseId: text("spouse_id"), // co-tutor (cónyuge) que comparte los niños; vínculo simétrico
  spousePendingFrom: text("spouse_pending_from"), // invitación de cónyuge pendiente de aceptar (id de quien invita)
  localeFormat: text("locale_format").notNull().default("es-ES"),
  digestAt: text("digest_at"), // última vez que se le envió el resumen semanal (cron; anti-spam)
  createdAt: text("created_at").notNull(),
});

export const childProfiles = sqliteTable("child_profiles", {
  id: text("id").primaryKey(),
  parentId: text("parent_id")
    .notNull()
    .references(() => parentAccounts.id),
  displayName: text("display_name").notNull(),
  avatar: text("avatar").notNull().default("orbi"),
  mascot: text("mascot").notNull().default("orbi"), // compañero astronauta que ve el niño (orbi, redpanda, fox...)
  birthYear: integer("birth_year"),
  gradeBand: text("grade_band").notNull(),
  loginPinHash: text("login_pin_hash"),
  username: text("username"), // login propio del niño (único)
  preferredLocale: text("preferred_locale").notNull().default("es"),
  region: text("region"),
  timezone: text("timezone"), // zona IANA del dispositivo del niño (para calcular "hoy" de la racha)
  consentAt: text("consent_at"), // ISO: cuándo el tutor consintió el tratamiento de datos del menor (RGPD)
  consentVersion: text("consent_version"), // versión de la política aceptada
  inactivityNotifiedAt: text("inactivity_notified_at"), // última alerta de inactividad enviada (cron; anti-spam)
}, (t) => [
  uniqueIndex("child_username_uq").on(t.username),
  index("children_parent_idx").on(t.parentId), // niños del hogar, en cada carga del panel
]);

/* ---------- Contenido (inmutable, versionado) ---------- */

export const subjects = sqliteTable("subjects", {
  id: text("id").primaryKey(),
  nameI18n: text("name_i18n", { mode: "json" }).$type<LocaleText>().notNull(),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id")
    .notNull()
    .references(() => subjects.id),
  gradeBand: text("grade_band").notNull(),
  nameI18n: text("name_i18n", { mode: "json" }).$type<LocaleText>().notNull(),
  difficultyBase: real("difficulty_base").notNull().default(0.4),
  position: integer("position").notNull().default(0),
  ownerId: text("owner_id"), // null = skill global (catálogo); set = skill privado del hogar del tutor
  coinsPerCorrect: integer("coins_per_correct"), // puntos por acierto (null = valor global por defecto)
  pathId: text("path_id"), // agrupa módulos de un mismo "path"; null = ficha suelta
  pathName: text("path_name", { mode: "json" }).$type<LocaleText>(), // nombre del path (si es módulo de uno)
  moduleIndex: integer("module_index").notNull().default(0), // orden del módulo dentro del path
  sessionLength: integer("session_length"), // preguntas por misión (null = valor por defecto de la app)
}, (t) => [
  index("skills_owner_idx").on(t.ownerId), // contenido privado del hogar
  index("skills_subject_grade_idx").on(t.subjectId, t.gradeBand), // catálogo por curso
]);

export const skillPrerequisites = sqliteTable(
  "skill_prerequisites",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    prerequisiteId: text("prerequisite_id")
      .notNull()
      .references(() => skills.id),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.prerequisiteId] }), index("skill_prereq_prereq_idx").on(t.prerequisiteId)],
);

export const contentPackages = sqliteTable("content_packages", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id")
    .notNull()
    .references(() => subjects.id),
  gradeBand: text("grade_band"),
  version: text("version").notNull(),
  status: text("status").notNull().default("published"),
  ownerId: text("owner_id"), // null = paquete global (catálogo); set = privado del hogar del tutor
  createdAt: text("created_at").notNull(),
});

export const exerciseTemplates = sqliteTable("exercise_templates", {
  id: text("id").primaryKey(),
  packageId: text("package_id")
    .notNull()
    .references(() => contentPackages.id),
  skillId: text("skill_id")
    .notNull()
    .references(() => skills.id),
  type: text("type").notNull(),
  language: text("language").notNull().default("es"),
  contentVersion: text("content_version").notNull().default("1.0.0"),
  stem: text("stem").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  difficultyNumeric: real("difficulty_numeric").notNull().default(0.5),
  difficultyLevel: text("difficulty_level").notNull().default("medium"),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false), // el tutor puede ocultar un ejercicio: el niño no lo recibe
  /**
   * Retirada AUTOMÁTICA al republicar: la plantilla ya no viene en el lote nuevo, pero no se
   * puede borrar porque `attempts` y `coin_awards` la referencian. Es distinta de `hidden`
   * (curación manual del tutor) para que republicar no pise su decisión ni deje ejercicios
   * ocultos para siempre si el paquete vuelve a crecer.
   */
  retired: integer("retired", { mode: "boolean" }).notNull().default(false),
}, (t) => [
  // Banco de ejercicios de un skill: se consulta en CADA ejercicio servido.
  index("templates_skill_idx").on(t.skillId, t.retired, t.hidden),
  index("templates_package_idx").on(t.packageId), // publicación y retirada por paquete
]);

/* ---------- Progreso (mutable, por perfil) ---------- */

export const skillProgress = sqliteTable(
  "skill_progress",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => childProfiles.id),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    masteryScore: real("mastery_score").notNull().default(0),
    consecutiveCorrect: integer("consecutive_correct").notNull().default(0),
    totalAttempts: integer("total_attempts").notNull().default(0),
    status: text("status").notNull().default("available"),
    fsrs: text("fsrs", { mode: "json" }),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.skillId] }), index("skill_progress_skill_idx").on(t.skillId)],
);

export const attempts = sqliteTable("attempts", {
  id: text("id").primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => childProfiles.id),
  skillId: text("skill_id")
    .notNull()
    .references(() => skills.id),
  exerciseTemplateId: text("exercise_template_id")
    .notNull()
    .references(() => exerciseTemplates.id),
  contentVersion: text("content_version").notNull(),
  correct: integer("correct", { mode: "boolean" }).notNull(),
  responseTimeMs: integer("response_time_ms"),
  difficultyServed: real("difficulty_served"),
  ts: text("ts").notNull(),
  answerGiven: text("answer_given", { mode: "json" }), // respuesta que dio el niño (para revisión de errores del tutor)
}, (t) => [
  // La tabla más leída del sistema: motor de sesión, estadísticas, racha y cron.
  index("attempts_profile_skill_ts_idx").on(t.profileId, t.skillId, t.ts), // anti-repetición de session/next
  index("attempts_profile_ts_idx").on(t.profileId, t.ts), // racha, estadísticas y última actividad
  index("attempts_template_idx").on(t.exerciseTemplateId), // revisión de errores del tutor
]);

/* ---------- Economía / recompensas ---------- */

export const wallets = sqliteTable("wallets", {
  profileId: text("profile_id")
    .primaryKey()
    .references(() => childProfiles.id),
  balance: integer("balance").notNull().default(0),
});

export const walletLedger = sqliteTable("wallet_ledger", {
  id: text("id").primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => childProfiles.id),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  ts: text("ts").notNull(),
}, (t) => [index("ledger_profile_ts_idx").on(t.profileId, t.ts)]); // earnedSince y el monedero

export const rewards = sqliteTable("rewards", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"), // tutor/hogar dueño; null = recompensa del sistema (sembrada)
  cost: integer("cost").notNull(), // spend: precio en puntos; goal: objetivo a acumular
  type: text("type").notNull(),
  kind: text("kind").notNull().default("spend"), // 'spend' (canjeable) | 'goal' (acumular en el tiempo)
  period: text("period"), // goal: ventana de acumulación 'week'|'month' (null = total)
  limitCount: integer("limit_count"), // máx. canjes por ventana (null = ilimitado)
  limitPeriod: text("limit_period").notNull().default("all"), // 'all'|'week'|'month'
  icon: text("icon"), // nombre de icono (para recompensas definidas por el tutor)
  payload: text("payload", { mode: "json" }),
  nameI18n: text("name_i18n", { mode: "json" }).$type<LocaleText>().notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // sha256(token de cookie)
  parentId: text("parent_id")
    .notNull()
    .references(() => parentAccounts.id),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [index("sessions_parent_idx").on(t.parentId), index("sessions_expires_idx").on(t.expiresAt)]);

export const redemptions = sqliteTable("redemptions", {
  id: text("id").primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => childProfiles.id),
  rewardId: text("reward_id")
    .notNull()
    .references(() => rewards.id),
  status: text("status").notNull().default("pending"),
  ts: text("ts").notNull(),
  // Escudo de racha (streak_freeze): un canje "applied" y sin consumir puede salvar UN día perdido.
  consumedAt: text("consumed_at"), // ISO en que se gastó el Escudo (null = disponible)
  consumedFor: text("consumed_for"), // día (yyyy-mm-dd) que cubrió, para que el cálculo sea estable entre recargas
}, (t) => [
  index("redemptions_profile_ts_idx").on(t.profileId, t.ts), // límites por ventana y "mis canjes"
  index("redemptions_reward_idx").on(t.rewardId), // bandeja del tutor y borrado en cascada
]);

/* ---------- Seguridad ---------- */

export const authTokens = sqliteTable("auth_tokens", {
  id: text("id").primaryKey(), // sha256(token)
  parentId: text("parent_id")
    .notNull()
    .references(() => parentAccounts.id),
  type: text("type").notNull(), // 'verify' | 'reset'
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [index("auth_tokens_parent_idx").on(t.parentId), index("auth_tokens_expires_idx").on(t.expiresAt)]);

export const loginAttempts = sqliteTable("login_attempts", {
  id: text("id").primaryKey(),
  ident: text("ident").notNull(),
  ts: text("ts").notNull(),
}, (t) => [index("login_attempts_ident_ts_idx").on(t.ident, t.ts)]); // rate-limit del login

/* ---------- Sesiones de niño + cursos ---------- */

export const childSessions = sqliteTable("child_sessions", {
  id: text("id").primaryKey(), // sha256(token)
  childId: text("child_id")
    .notNull()
    .references(() => childProfiles.id),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [index("child_sessions_child_idx").on(t.childId), index("child_sessions_expires_idx").on(t.expiresAt)]);

/** Un curso = asignatura + nivel (p.ej. Matemáticas · ESO-5). */
export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id")
    .notNull()
    .references(() => subjects.id),
  gradeBand: text("grade_band").notNull(),
  nameI18n: text("name_i18n", { mode: "json" }).$type<LocaleText>().notNull(),
});

/** Acceso de un niño a un curso (lo concede el tutor). */
export const childCourses = sqliteTable(
  "child_courses",
  {
    childId: text("child_id")
      .notNull()
      .references(() => childProfiles.id),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id),
  },
  (t) => [primaryKey({ columns: [t.childId, t.courseId] }), index("child_courses_course_idx").on(t.courseId)],
);

/** Acceso de un niño a una recompensa (lo concede el tutor). */
export const childRewards = sqliteTable(
  "child_rewards",
  {
    childId: text("child_id")
      .notNull()
      .references(() => childProfiles.id),
    rewardId: text("reward_id")
      .notNull()
      .references(() => rewards.id),
  },
  (t) => [primaryKey({ columns: [t.childId, t.rewardId] }), index("child_rewards_reward_idx").on(t.rewardId)],
);

/* ---------- Contenido privado del hogar + solicitudes de generación (Vía B) ---------- */

/** Acceso de un niño a un skill PRIVADO (contenido generado para su hogar). */
export const childSkills = sqliteTable(
  "child_skills",
  {
    childId: text("child_id")
      .notNull()
      .references(() => childProfiles.id),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
  },
  (t) => [primaryKey({ columns: [t.childId, t.skillId] }), index("child_skills_skill_idx").on(t.skillId)],
);

/** Solicitud de contenido a partir de material subido por el tutor (fotos, PDF, texto). */
export const contentRequests = sqliteTable("content_requests", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => parentAccounts.id), // tutor que crea la solicitud
  childId: text("child_id").references(() => childProfiles.id), // niño destino (a quién se asignará)
  subjectId: text("subject_id"), // pista opcional de asignatura
  gradeBand: text("grade_band"), // pista opcional de nivel
  title: text("title").notNull(),
  instructions: text("instructions").notNull().default(""), // qué quiere generar el tutor
  numQuestions: integer("num_questions"), // preguntas a generar (null = por defecto)
  pointsPerCorrect: integer("points_per_correct"), // puntos por acierto
  modules: integer("modules"), // 1 = ficha única; >1 = path con N módulos
  questionTypes: text("question_types", { mode: "json" }).$type<string[]>(), // tipos de ejercicio pedidos (null = variados)
  sessionLength: integer("session_length"), // preguntas por misión del contenido generado
  sourceRequestId: text("source_request_id"), // si es una copia regenerada: la solicitud de la que sale (y sus ficheros)
  status: text("status").notNull().default("uploaded"), // uploaded | processing | published | failed
  note: text("note"), // nota/error del procesado
  skillId: text("skill_id"), // skill privado publicado al terminar
  packageId: text("package_id"), // paquete publicado
  exerciseCount: integer("exercise_count"),
  createdAt: text("created_at").notNull(),
  publishedAt: text("published_at"),
  notifiedAt: text("notified_at"),
}, (t) => [index("content_requests_owner_status_idx").on(t.ownerId, t.status)]);

/** Registro atómico de la PRIMERA vez que se acierta cada ejercicio (anti-farm sin carrera).
 *  La PK compuesta garantiza que las monedas se concedan una única vez por (niño, ejercicio). */
export const coinAwards = sqliteTable(
  "coin_awards",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => childProfiles.id),
    exerciseTemplateId: text("exercise_template_id")
      .notNull()
      .references(() => exerciseTemplates.id),
    ts: text("ts").notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.exerciseTemplateId] }), index("coin_awards_template_idx").on(t.exerciseTemplateId)],
);

/** «Esta pregunta está mal»: un niño marca un ejercicio como erróneo tras responderlo. Uno por
 *  (niño, ejercicio); volver a marcarlo lo reabre. Lo revisa el tutor del hogar (ocultar la pregunta
 *  o descartar el aviso); si el ejercicio es del catálogo global, el cron avisa además al admin. */
export const exerciseReports = sqliteTable(
  "exercise_reports",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => childProfiles.id),
    exerciseTemplateId: text("exercise_template_id")
      .notNull()
      .references(() => exerciseTemplates.id),
    reason: text("reason").notNull(), // 'wrong_answer' | 'unclear' | 'other'
    answerGiven: text("answer_given", { mode: "json" }), // última respuesta del niño (la copia el SERVIDOR de attempts)
    correct: integer("correct", { mode: "boolean" }), // cómo la corrigió el servidor
    status: text("status").notNull().default("open"), // 'open' | 'dismissed' | 'hidden'
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.exerciseTemplateId] }), index("exercise_reports_template_idx").on(t.exerciseTemplateId)],
);

/** Fichero subido para una solicitud (imagen o documento). El binario vive en R2. */
export const contentRequestAssets = sqliteTable("content_request_assets", {
  id: text("id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .references(() => contentRequests.id),
  r2Key: text("r2_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(), // image/png, application/pdf, text/plain, ...
  kind: text("kind").notNull(), // 'image' | 'document'
  size: integer("size").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [index("request_assets_request_idx").on(t.requestId)]);

/** Suscripción de Web Push (tutor o niño). Sin FK a propósito (ownerId es par_ o kid_);
 *  se limpia por ownerId al borrar. `endpoint` único para poder hacer upsert. */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  ownerType: text("owner_type").notNull(), // 'parent' | 'child'
  ownerId: text("owner_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(), // clave pública del cliente (base64url)
  auth: text("auth").notNull(), // secreto de auth del cliente (base64url)
  createdAt: text("created_at").notNull(),
}, (t) => [index("push_owner_idx").on(t.ownerId)]);

/** Credencial WebAuthn (passkey) de un tutor: login biométrico (Face ID / huella). */
export const webauthnCredentials = sqliteTable("webauthn_credentials", {
  id: text("id").primaryKey(), // credentialID (base64url)
  parentId: text("parent_id")
    .notNull()
    .references(() => parentAccounts.id),
  publicKey: text("public_key").notNull(), // clave pública COSE (base64url)
  counter: integer("counter").notNull().default(0),
  transports: text("transports"), // JSON: ["internal","hybrid",...]
  createdAt: text("created_at").notNull(),
});

/** Challenge efímero de una ceremonia WebAuthn (registro o login). Se borra al verificar. */
export const webauthnFlows = sqliteTable("webauthn_flows", {
  id: text("id").primaryKey(), // flowId aleatorio devuelto al cliente
  kind: text("kind").notNull(), // 'reg' | 'auth'
  userId: text("user_id"), // parentId en registro; null en login (usernameless)
  challenge: text("challenge").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [index("webauthn_flows_expires_idx").on(t.expiresAt)]);
