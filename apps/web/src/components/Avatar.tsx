// Avatares SVG de los niños (sustituyen a los emojis). Se guardan por CLAVE (p.ej. "fox").
// avatarKeyOf() mapea valores antiguos (emoji o "orbi") a una clave válida para no perder datos.
import type { ReactElement } from "react";

export const AVATAR_KEYS = ["orbi", "fox", "panda", "octo", "unicorn", "frog", "tiger", "robot"] as const;
export type AvatarKey = (typeof AVATAR_KEYS)[number];

const GRAD: Record<AvatarKey, [string, string]> = {
  orbi: ["#37e1e8", "#b14bff"],
  fox: ["#ff9d4d", "#ff6b3d"],
  panda: ["#cfd6ee", "#9aa6cf"],
  octo: ["#b14bff", "#7c3aed"],
  unicorn: ["#ff8fd0", "#ff5fae"],
  frog: ["#66d98a", "#2fae5f"],
  tiger: ["#ffcf5c", "#ff9f2e"],
  robot: ["#8fb2d8", "#5f7fb0"],
};

const OLD_TO_KEY: Record<string, AvatarKey> = {
  "🦊": "fox",
  "🐼": "panda",
  "🐙": "octo",
  "🦄": "unicorn",
  "🐸": "frog",
  "🐯": "tiger",
  "🤖": "robot",
  "🚀": "orbi",
};

export function avatarKeyOf(value: string | null | undefined): AvatarKey {
  if (!value) return "orbi";
  if ((AVATAR_KEYS as readonly string[]).includes(value)) return value as AvatarKey;
  return OLD_TO_KEY[value] ?? "orbi";
}

function Eyes() {
  return (
    <g>
      <circle cx="26" cy="34" r="5" fill="#0a0d1f" />
      <circle cx="46" cy="34" r="5" fill="#0a0d1f" />
      <circle cx="27.6" cy="32.4" r="1.6" fill="#fff" />
      <circle cx="47.6" cy="32.4" r="1.6" fill="#fff" />
    </g>
  );
}

const FEATURES: Record<AvatarKey, ReactElement> = {
  orbi: (
    <g>
      <Eyes />
      <path d="M28 44c4 3 8 3 12 0" stroke="#0a0d1f" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </g>
  ),
  fox: (
    <g>
      <path d="M14 20l8 8-10 2zM58 20l-8 8 10 2z" fill="#ff6b3d" />
      <Eyes />
      <path d="M33 42l3 3 3-3" stroke="#0a0d1f" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  ),
  panda: (
    <g>
      <circle cx="18" cy="20" r="7" fill="#31384f" />
      <circle cx="54" cy="20" r="7" fill="#31384f" />
      <ellipse cx="26" cy="34" rx="7" ry="8" fill="#31384f" />
      <ellipse cx="46" cy="34" rx="7" ry="8" fill="#31384f" />
      <circle cx="26" cy="35" r="3.4" fill="#fff" />
      <circle cx="46" cy="35" r="3.4" fill="#fff" />
    </g>
  ),
  octo: (
    <g>
      <Eyes />
      <path d="M18 52c2-4 4-4 6 0s4 4 6 0 4-4 6 0 4 4 6 0 4-4 6 0" stroke="#4a2b7a" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  ),
  unicorn: (
    <g>
      <path d="M32 6l5 14h-10z" fill="#ffd166" />
      <Eyes />
      <circle cx="36" cy="44" r="2.4" fill="#ff5fae" />
    </g>
  ),
  frog: (
    <g>
      <circle cx="22" cy="18" r="8" fill="#2fae5f" />
      <circle cx="42" cy="18" r="8" fill="#2fae5f" />
      <circle cx="22" cy="18" r="4" fill="#0a0d1f" />
      <circle cx="42" cy="18" r="4" fill="#0a0d1f" />
      <path d="M26 42c4 4 8 4 12 0" stroke="#0a0d1f" strokeWidth="2.6" fill="none" strokeLinecap="round" />
    </g>
  ),
  tiger: (
    <g>
      <circle cx="18" cy="18" r="6" fill="#ff9f2e" />
      <circle cx="46" cy="18" r="6" fill="#ff9f2e" />
      <path d="M10 30l6 2M10 40l6 1M54 30l-6 2M54 40l-6 1" stroke="#8a4b12" strokeWidth="2.2" strokeLinecap="round" />
      <Eyes />
    </g>
  ),
  robot: (
    <g>
      <path d="M32 6v8" stroke="#5f7fb0" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="32" cy="6" r="3" fill="#37e1e8" />
      <rect x="18" y="28" width="12" height="9" rx="2.5" fill="#0a0d1f" />
      <rect x="34" y="28" width="12" height="9" rx="2.5" fill="#0a0d1f" />
      <circle cx="24" cy="32.5" r="2" fill="#37e1e8" />
      <circle cx="40" cy="32.5" r="2" fill="#37e1e8" />
      <path d="M26 46h12" stroke="#0a0d1f" strokeWidth="2.4" strokeLinecap="round" />
    </g>
  ),
};

export function Avatar({ name, size = 40, className }: { name: string; size?: number; className?: string }) {
  const key = avatarKeyOf(name);
  const [c1, c2] = GRAD[key];
  const gid = `av-${key}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c1} />
          <stop offset="1" stopColor={c2} />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#${gid})`} />
      {FEATURES[key]}
    </svg>
  );
}
