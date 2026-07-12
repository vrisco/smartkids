import { sqliteTable, text, integer, real, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  createdAt: text("created_at").notNull(),
});

export const childProfiles = sqliteTable("child_profiles", {
  id: text("id").primaryKey(),
  parentId: text("parent_id")
    .notNull()
    .references(() => parentAccounts.id),
  displayName: text("display_name").notNull(),
  avatar: text("avatar").notNull().default("orbi"),
  birthYear: integer("birth_year"),
  gradeBand: text("grade_band").notNull(),
  loginPinHash: text("login_pin_hash"),
  username: text("username"), // login propio del niño (único)
  preferredLocale: text("preferred_locale").notNull().default("es"),
  region: text("region"),
}, (t) => [uniqueIndex("child_username_uq").on(t.username)]);

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
});

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
  (t) => [primaryKey({ columns: [t.skillId, t.prerequisiteId] })],
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
});

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
  (t) => [primaryKey({ columns: [t.profileId, t.skillId] })],
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
});

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
});

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
});

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
});

/* ---------- Seguridad ---------- */

export const authTokens = sqliteTable("auth_tokens", {
  id: text("id").primaryKey(), // sha256(token)
  parentId: text("parent_id")
    .notNull()
    .references(() => parentAccounts.id),
  type: text("type").notNull(), // 'verify' | 'reset'
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const loginAttempts = sqliteTable("login_attempts", {
  id: text("id").primaryKey(),
  ident: text("ident").notNull(),
  ts: text("ts").notNull(),
});

/* ---------- Sesiones de niño + cursos ---------- */

export const childSessions = sqliteTable("child_sessions", {
  id: text("id").primaryKey(), // sha256(token)
  childId: text("child_id")
    .notNull()
    .references(() => childProfiles.id),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

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
  (t) => [primaryKey({ columns: [t.childId, t.courseId] })],
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
  (t) => [primaryKey({ columns: [t.childId, t.rewardId] })],
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
  (t) => [primaryKey({ columns: [t.childId, t.skillId] })],
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
  status: text("status").notNull().default("uploaded"), // uploaded | processing | published | failed
  note: text("note"), // nota/error del procesado
  skillId: text("skill_id"), // skill privado publicado al terminar
  packageId: text("package_id"), // paquete publicado
  exerciseCount: integer("exercise_count"),
  createdAt: text("created_at").notNull(),
  publishedAt: text("published_at"),
  notifiedAt: text("notified_at"),
});

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
});
