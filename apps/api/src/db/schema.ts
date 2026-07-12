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
  cost: integer("cost").notNull(),
  type: text("type").notNull(),
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
