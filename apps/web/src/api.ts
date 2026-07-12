import i18n from "./i18n";
import type { Answer, RenderPayload } from "@smartkids/shared";

// Re-export de los tipos del modelo unificado para el resto de la web.
export type { Answer, RenderPayload };

export type LocaleText = Record<string, string>;

export interface SkillNode {
  id: string;
  position: number;
  nameI18n: LocaleText;
  gradeBand: string;
  status: string | null;
  masteryScore: number | null;
  totalAttempts?: number | null;
}

export interface Parent {
  id: string;
  email: string;
  role: string; // 'admin' | 'tutor'
  emailVerified: boolean;
}

export interface Child {
  id: string;
  displayName: string;
  username?: string | null;
  avatar: string;
  gradeBand: string;
}

export interface Course {
  id: string;
  subjectId: string;
  gradeBand: string;
  nameI18n: LocaleText;
}

export interface Spouse {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface Me {
  parent: Parent;
  spouse?: Spouse | null;
  spouseInviteIn?: { fromEmail: string } | null;
  spouseInviteOut?: { toEmail: string } | null;
  children: Child[];
}

export interface CustomContent {
  skillId: string;
  nameI18n: LocaleText;
  exercises: number;
  pathId?: string | null;
  pathName?: LocaleText | null;
  moduleIndex?: number;
}

export interface ChildMe {
  child: { id: string; displayName: string; avatar: string; gradeBand: string };
  balance: number;
  courses: Course[];
  customContent?: CustomContent[];
}

export interface Tutor {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface Exercise {
  id: string;
  skillId: string;
  type: string;
  stem: string;
  contentVersion: string;
  render: RenderPayload;
}
export interface AttemptResult {
  correct: boolean;
  correctAnswer?: Answer | null;
  parts?: boolean[] | null;
  feedback?: string | null;
  solution?: string | null;
  coinsAwarded: number;
  balance: number;
  masteryScore: number;
  status: string;
}
export interface Reward {
  id: string;
  cost: number;
  type: string;
  kind: string; // 'spend' | 'goal'
  period?: string | null; // goal: 'week' | 'month'
  limitCount?: number | null;
  limitPeriod?: string; // 'all' | 'week' | 'month'
  icon?: string | null;
  payload?: unknown;
  nameI18n: LocaleText;
  // Calculados por el servidor para el niño:
  progress?: number | null; // goal: puntos acumulados en la ventana
  claimable?: boolean;
  redeemedInWindow?: number;
}

export interface TutorReward {
  id: string;
  cost: number;
  kind: string;
  period?: string | null;
  limitCount?: number | null;
  limitPeriod?: string;
  icon?: string | null;
  nameI18n: LocaleText;
  childIds: string[];
}

export interface RewardInput {
  name: string;
  cost: number;
  icon: string;
  childIds: string[];
  kind: string; // 'spend' | 'goal'
  period?: string; // goal
  limitCount?: number | null;
  limitPeriod?: string;
}

export interface Redemption {
  id: string;
  childName: string;
  rewardName: LocaleText;
  kind: string;
  cost: number;
  ts: string;
}

export interface ContentAsset {
  id: string;
  filename: string;
  kind: string;
  size: number;
}

export interface ContentRequest {
  id: string;
  title: string;
  instructions: string;
  status: string; // uploaded | processing | published | failed
  childId?: string | null;
  subjectId?: string | null;
  gradeBand?: string | null;
  numQuestions?: number | null;
  pointsPerCorrect?: number | null;
  modules?: number | null;
  exerciseCount?: number | null;
  skillId?: string | null;
  createdAt: string;
  publishedAt?: string | null;
  assets?: ContentAsset[];
}

export interface PrivateSkill {
  id: string;
  nameI18n: LocaleText;
  subjectId: string;
  gradeBand: string;
  exercises: number;
  childIds: string[];
}

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      msg = b.message ?? b.error ?? msg;
    } catch {
      /* sin cuerpo */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  // Tutor / admin auth
  me: () => j<Me>(`/api/auth/me`),
  login: (email: string, password: string) => j<{ parent: Parent }>(`/api/auth/login`, post({ email, password })),
  logout: () => j<{ ok: boolean }>(`/api/auth/logout`, { method: "POST" }),
  forgot: (email: string) => j<{ ok: boolean; devLink?: string }>(`/api/auth/forgot`, post({ email })),
  reset: (token: string, password: string) => j<{ ok: boolean }>(`/api/auth/reset`, post({ token, password })),
  verifyEmail: (token: string) => j<{ ok: boolean }>(`/api/auth/verify`, post({ token })),
  resendVerification: () => j<{ ok: boolean; devLink?: string }>(`/api/auth/resend-verification`, { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    j<{ ok: boolean }>(`/api/auth/change-password`, post({ currentPassword, newPassword })),

  // Admin
  adminTutors: () => j<Tutor[]>(`/api/admin/tutors`),
  createTutor: (email: string) => j<{ tutor: { id: string; email: string }; devLink?: string; reinvited?: boolean }>(`/api/admin/tutors`, post({ email })),
  resetTutorPassword: (id: string) => j<{ ok: boolean; devLink?: string }>(`/api/admin/tutors/${id}/reset-password`, { method: "POST" }),
  deleteTutor: (id: string) => j<{ ok: boolean }>(`/api/admin/tutors/${id}`, { method: "DELETE" }),

  // Cursos + niños (tutor)
  courses: () => j<Course[]>(`/api/courses`),
  createChild: (data: { displayName: string; username: string; avatar: string; gradeBand: string; pin: string; courseIds: string[] }) =>
    j<{ profile: Child }>(`/api/profiles`, post(data)),
  updateChild: (id: string, data: { displayName?: string; avatar?: string; pin?: string; username?: string }) =>
    j<{ profile: Child }>(`/api/profiles/${id}/update`, post(data)),
  deleteChild: (id: string) => j<{ ok: boolean }>(`/api/profiles/${id}`, { method: "DELETE" }),
  setChildCourses: (id: string, courseIds: string[]) => j<{ ok: boolean; courseIds: string[] }>(`/api/profiles/${id}/courses`, post({ courseIds })),
  childCourses: (id: string) => j<Course[]>(`/api/profiles/${id}/courses`),

  // Cónyuge (co-tutor que comparte los niños) — vinculación con consentimiento bilateral
  inviteSpouse: (email: string) => j<{ ok: boolean; pending: boolean; invitee: { email: string }; devLink?: string }>(`/api/tutor/spouse`, post({ email })),
  acceptSpouse: () => j<{ ok: boolean }>(`/api/tutor/spouse/accept`, { method: "POST" }),
  rejectSpouse: () => j<{ ok: boolean }>(`/api/tutor/spouse/reject`, { method: "POST" }),
  unlinkSpouse: () => j<{ ok: boolean }>(`/api/tutor/spouse`, { method: "DELETE" }),

  // Niño auth
  childMe: () => j<ChildMe>(`/api/child/me`),
  childLogin: (username: string, pin: string) => j<{ child: ChildMe["child"]; courses: Course[] }>(`/api/child/login`, post({ username, pin })),
  childLogout: () => j<{ ok: boolean }>(`/api/child/logout`, { method: "POST" }),

  // Juego
  skills: (profileId: string, courseId: string) => j<SkillNode[]>(`/api/skills?profile=${profileId}&course=${courseId}`),
  nextExercise: (skillId: string, profileId: string, exclude: string[] = []) =>
    j<Exercise>(
      `/api/session/next?skill=${encodeURIComponent(skillId)}&profile=${encodeURIComponent(profileId)}` +
        (exclude.length ? `&exclude=${encodeURIComponent(exclude.join(","))}` : ""),
    ),
  attempt: (body: { profileId: string; exerciseTemplateId: string; answer: Answer; responseTimeMs?: number }) =>
    j<AttemptResult>(`/api/session/attempt`, post(body)),
  rewards: () => j<Reward[]>(`/api/rewards`),
  redeem: (rewardId: string, profileId: string) => j<{ ok: boolean; balance: number; status: string }>(`/api/rewards/${rewardId}/redeem`, post({ profileId })),

  // Recompensas definidas por el tutor (asignadas por niño)
  tutorRewards: () => j<TutorReward[]>(`/api/tutor/rewards`),
  createReward: (data: RewardInput) => j<{ reward: { id: string } }>(`/api/tutor/rewards`, post(data)),
  updateReward: (id: string, data: Partial<RewardInput>) =>
    j<{ ok: boolean }>(`/api/tutor/rewards/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
  deleteReward: (id: string) => j<{ ok: boolean }>(`/api/tutor/rewards/${id}`, { method: "DELETE" }),

  // Canjes pendientes de conceder (bandeja del tutor)
  tutorRedemptions: () => j<Redemption[]>(`/api/tutor/redemptions`),
  grantRedemption: (id: string) => j<{ ok: boolean }>(`/api/tutor/redemptions/${id}/grant`, { method: "POST" }),
  rejectRedemption: (id: string) => j<{ ok: boolean }>(`/api/tutor/redemptions/${id}/reject`, { method: "POST" }),

  // Contenido a medida (Vía B): solicitudes con subida de material + contenido privado del hogar
  contentRequests: () => j<ContentRequest[]>(`/api/tutor/content-requests`),
  createContentRequest: async (form: FormData): Promise<{ ok: boolean; requestId: string }> => {
    const res = await fetch(`/api/tutor/content-requests`, { method: "POST", body: form });
    if (!res.ok) {
      let m = `${res.status}`;
      try {
        const b = (await res.json()) as { detail?: string; error?: string };
        m = b.detail ?? b.error ?? m;
      } catch {
        /* sin cuerpo */
      }
      throw new Error(m);
    }
    return (await res.json()) as { ok: boolean; requestId: string };
  },
  updateContentRequest: async (id: string, form: FormData): Promise<{ ok: boolean }> => {
    const res = await fetch(`/api/tutor/content-requests/${id}`, { method: "POST", body: form });
    if (!res.ok) {
      let m = `${res.status}`;
      try {
        const b = (await res.json()) as { detail?: string; message?: string; error?: string };
        m = b.detail ?? b.message ?? b.error ?? m;
      } catch {
        /* sin cuerpo */
      }
      throw new Error(m);
    }
    return (await res.json()) as { ok: boolean };
  },
  deleteRequestAsset: (reqId: string, assetId: string) =>
    j<{ ok: boolean }>(`/api/tutor/content-requests/${reqId}/assets/${assetId}`, { method: "DELETE" }),
  tutorContent: () => j<PrivateSkill[]>(`/api/tutor/content`),
  assignSkill: (skillId: string, childIds: string[]) =>
    j<{ ok: boolean; childIds: string[] }>(`/api/tutor/skills/${skillId}/assign`, post({ childIds })),
  deleteContentSkill: (skillId: string) => j<{ ok: boolean }>(`/api/tutor/skills/${skillId}`, { method: "DELETE" }),
  deleteContentRequest: (id: string) => j<{ ok: boolean }>(`/api/tutor/content-requests/${id}`, { method: "DELETE" }),
};

export const tx = (m: LocaleText | null | undefined, locale: string = i18n.language): string =>
  (m && (m[locale] ?? Object.values(m)[0])) ?? "";
