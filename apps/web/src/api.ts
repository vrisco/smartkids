export type LocaleText = Record<string, string>;

export interface SkillNode {
  id: string;
  position: number;
  nameI18n: LocaleText;
  gradeBand: string;
  difficultyBase?: number;
  status: string | null;
  masteryScore: number | null;
  totalAttempts?: number | null;
}

export interface Profile {
  id: string;
  displayName: string;
  avatar: string;
  gradeBand: string;
  preferredLocale: string;
  region: string | null;
}

export interface ProfileState {
  profile: Profile;
  balance: number;
}

export interface Option {
  id: string;
  text: string;
  isCorrect: boolean;
}

export interface Exercise {
  id: string;
  skillId: string;
  type: string;
  stem: string;
  contentVersion: string;
  payload: {
    options?: Option[];
    feedback?: { correct?: string; incorrect?: string };
  };
}

export interface AttemptResult {
  correct: boolean;
  coinsAwarded: number;
  balance: number;
  masteryScore: number;
  consecutiveCorrect: number;
  status: string;
}

export interface Reward {
  id: string;
  cost: number;
  type: string;
  payload: unknown;
  nameI18n: LocaleText;
}

export interface Parent {
  id: string;
  email: string;
}

export interface Child {
  id: string;
  displayName: string;
  avatar: string;
  gradeBand: string;
}

export interface Me {
  parent: Parent;
  children: Child[];
}

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      msg = body.message ?? body.error ?? msg;
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  // Auth
  me: () => j<Me>(`/api/auth/me`),
  signup: (email: string, password: string) =>
    j<{ parent: Parent }>(`/api/auth/signup`, jsonPost({ email, password })),
  login: (email: string, password: string) =>
    j<{ parent: Parent }>(`/api/auth/login`, jsonPost({ email, password })),
  logout: () => j<{ ok: boolean }>(`/api/auth/logout`, { method: "POST" }),
  createChild: (data: { displayName: string; avatar: string; gradeBand: string; pin: string }) =>
    j<{ profile: Child }>(`/api/profiles`, jsonPost(data)),
  unlock: (id: string, pin: string) =>
    j<{ profile: Child }>(`/api/profiles/${id}/unlock`, jsonPost({ pin })),

  // Datos de juego
  profile: (id: string) => j<ProfileState>(`/api/profiles/${id}`),
  skills: (profileId: string, subject = "math") =>
    j<SkillNode[]>(`/api/skills?subject=${subject}&profile=${profileId}`),
  nextExercise: (skillId: string, profileId: string) =>
    j<Exercise>(`/api/session/next?skill=${skillId}&profile=${profileId}`),
  attempt: (body: {
    profileId: string;
    skillId: string;
    exerciseTemplateId: string;
    contentVersion?: string;
    correct: boolean;
    responseTimeMs?: number;
  }) => j<AttemptResult>(`/api/session/attempt`, jsonPost(body)),
  rewards: () => j<Reward[]>(`/api/rewards`),
  redeem: (rewardId: string, profileId: string) =>
    j<{ ok: boolean; balance: number; status: string }>(
      `/api/rewards/${rewardId}/redeem`,
      jsonPost({ profileId }),
    ),
};

/** Escoge el texto del idioma pedido con fallback al primero disponible. */
export const tx = (m: LocaleText | undefined, locale = "es"): string =>
  (m && (m[locale] ?? Object.values(m)[0])) ?? "";
