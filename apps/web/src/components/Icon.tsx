// Sistema de iconos SVG (reemplaza los emojis de la UI). Heredan el color con currentColor
// y el tamaño por prop. Trazo por defecto; los "rellenos" (coin, planet, star) usan fill.
import type { CSSProperties, ReactElement } from "react";

export type IconName =
  | "coin"
  | "flame"
  | "lock"
  | "check"
  | "close"
  | "play"
  | "back"
  | "arrow"
  | "plus"
  | "mail"
  | "rocket"
  | "satellite"
  | "planet"
  | "book"
  | "shield"
  | "clock"
  | "medal"
  | "star"
  | "globe"
  | "sun"
  | "moon"
  | "gift"
  | "target"
  | "chevronUp"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "eye"
  | "eyeOff";

const STROKE: Partial<Record<IconName, ReactElement>> = {
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  check: <path d="M4 12.5l5 5L20 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.5 5.9A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.6 15.6 0 0 1-3 3.6" />
      <path d="M6.3 7.8A15.7 15.7 0 0 0 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 3.6-.7" />
      <path d="M9.9 9.9A3 3 0 0 0 14.1 14.1" />
    </>
  ),
  play: <path d="M8 5l11 7-11 7z" />,
  back: <path d="M15 5l-7 7 7 7" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 3c3 1.5 5 4.8 5 9 0 2-.6 3.8-1.5 5H8.5C7.6 15.8 7 14 7 12c0-4.2 2-7.5 5-9Z" />
      <circle cx="12" cy="10" r="1.6" />
      <path d="M9 18l-2 3M15 18l2 3" />
    </>
  ),
  satellite: (
    <>
      <path d="M5 15l4-4 4 4-4 4-4-4Z" />
      <path d="M11 9l4-4M13 7l3 3" />
      <path d="M14 14a4 4 0 0 0 0-5.7M17 17a8 8 0 0 0 0-11.3" />
    </>
  ),
  book: (
    <>
      <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z" />
      <path d="M5 17h13" />
    </>
  ),
  shield: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />,
  gift: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="1.5" />
      <path d="M4 13h16M12 9v11" />
      <path d="M12 9C10 5.5 6.5 6 7.6 8.3 8.3 9 12 9 12 9ZM12 9c2-3.5 5.5-3 4.4-.7C15.7 9 12 9 12 9Z" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
};

const FILL: Partial<Record<IconName, ReactElement>> = {
  coin: (
    <>
      <circle cx="12" cy="12" r="9" opacity="0.18" />
      <path d="M12 4l1.9 5.6H20l-4.9 3.6 1.9 5.7L12 15.3 7 18.9l1.9-5.7L4 9.6h6.1L12 4Z" />
    </>
  ),
  star: (
    <path d="M12 4l1.9 5.6H20l-4.9 3.6 1.9 5.7L12 15.3 7 18.9l1.9-5.7L4 9.6h6.1L12 4Z" />
  ),
  flame: (
    <path d="M12 3c1 3-1.5 4-1.5 6.5C10.5 11 11.3 12 12 12s1.7-.8 1.7-2.2c0-.6-.1-1-.2-1.4C15.4 9.6 17 12 17 14.5A5 5 0 0 1 7 14.5C7 10.5 11 8 12 3Z" />
  ),
  planet: (
    <>
      <circle cx="12" cy="11" r="6.5" />
      <ellipse cx="12" cy="12.5" rx="10" ry="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" transform="rotate(-18 12 12.5)" opacity="0.75" />
    </>
  ),
  medal: (
    <>
      <circle cx="12" cy="14" r="5.5" />
      <path d="M9 3l3 6 3-6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  className,
  style,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}) {
  const filled = FILL[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {filled ?? STROKE[name]}
    </svg>
  );
}
