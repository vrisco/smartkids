/** Orbi — la mascota astronauta de smartkids, dibujada en SVG (escala sin pixelarse). */
export function Orbi({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 140 152"
      role="img"
      aria-label="Orbi, la mascota astronauta"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="orbiGlow" cx="50%" cy="46%" r="55%">
          <stop offset="0%" stopColor="#37E1E8" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#37E1E8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="orbiVisor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0B1030" />
          <stop offset="55%" stopColor="#182055" />
          <stop offset="100%" stopColor="#0A0E28" />
        </linearGradient>
        <linearGradient id="orbiSuit" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#F4F6FF" />
          <stop offset="100%" stopColor="#C4CDF2" />
        </linearGradient>
      </defs>
      <ellipse cx="70" cy="80" rx="62" ry="62" fill="url(#orbiGlow)" />
      <line x1="70" y1="18" x2="70" y2="40" stroke="#8FA0D8" strokeWidth="4" strokeLinecap="round" />
      <circle cx="70" cy="15" r="13" fill="#FFD166" opacity="0.28" />
      <circle cx="70" cy="15" r="7" fill="#FFD166" />
      <rect x="41" y="94" width="58" height="46" rx="23" fill="url(#orbiSuit)" />
      <rect x="22" y="98" width="27" height="14" rx="7" fill="url(#orbiSuit)" />
      <rect x="91" y="98" width="27" height="14" rx="7" fill="url(#orbiSuit)" />
      <circle cx="70" cy="118" r="7" fill="#37E1E8" />
      <circle cx="70" cy="118" r="11" fill="#37E1E8" opacity="0.2" />
      <circle cx="70" cy="66" r="46" fill="url(#orbiSuit)" />
      <path
        d="M34 60 a36 33 0 0 1 72 0 v9 a36 31 0 0 1 -72 0 z"
        fill="url(#orbiVisor)"
        stroke="#37E1E8"
        strokeWidth="2.5"
      />
      <circle cx="56" cy="64" r="8.5" fill="#EAFBFF" />
      <circle cx="84" cy="64" r="8.5" fill="#EAFBFF" />
      <circle cx="57.5" cy="65" r="4.6" fill="#37E1E8" />
      <circle cx="85.5" cy="65" r="4.6" fill="#37E1E8" />
      <circle cx="59.5" cy="62" r="1.7" fill="#fff" />
      <circle cx="87.5" cy="62" r="1.7" fill="#fff" />
      <path d="M60 76 q10 8 20 0" fill="none" stroke="#37E1E8" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
