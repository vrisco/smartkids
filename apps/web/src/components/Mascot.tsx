// Compañeros de viaje del niño (mascotas), todos con el estilo astronauta de Orbi: el mismo traje con luz
// en el pecho y, en los animales, casco de cristal con antena. Se guardan por CLAVE en child_profiles.mascot
// (la misma lista vive en apps/api/src/index.ts → MASCOTS); mascotKeyOf() cae a "orbi" ante un valor desconocido.
// Dentro de la app del niño, <Mascot /> sin `name` pinta el compañero elegido (MascotContext lo provee KidApp).
import { createContext, useContext, useId, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

export const MASCOT_KEYS = [
  "orbi",
  "redpanda",
  "fox",
  "cat",
  "bunny",
  "panda",
  "penguin",
] as const;
export type MascotKey = (typeof MASCOT_KEYS)[number];

export function mascotKeyOf(value: string | null | undefined): MascotKey {
  return value && (MASCOT_KEYS as readonly string[]).includes(value)
    ? (value as MascotKey)
    : "orbi";
}

export const MascotContext = createContext<MascotKey>("orbi");

// Último compañero usado en este dispositivo: la pantalla de login lo muestra antes de haber sesión.
const LAST_KEY = "sk_mascot";
export function lastMascot(): MascotKey {
  try {
    return mascotKeyOf(localStorage.getItem(LAST_KEY));
  } catch {
    return "orbi";
  }
}
export function rememberMascot(key: MascotKey) {
  try {
    localStorage.setItem(LAST_KEY, key);
  } catch {
    /* almacenamiento bloqueado: solo se pierde el recuerdo en el login */
  }
}

/** Compañero con nombre accesible traducido. Sin `name`, usa el del niño (MascotContext). */
export function Mascot({
  name,
  className,
}: {
  name?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const ctx = useContext(MascotContext);
  const key = name ? mascotKeyOf(name) : ctx;
  return (
    <MascotArt
      kind={key}
      className={className}
      label={t(`mascot.names.${key}`)}
    />
  );
}

/** El personaje como avatar redondo (busto): barra superior del niño y lista de niños del tutor. */
export function MascotAvatar({ name, size = 40, className }: { name?: string; size?: number; className?: string }) {
  const { t } = useTranslation();
  const ctx = useContext(MascotContext);
  const key = name ? mascotKeyOf(name) : ctx;
  return <MascotArt kind={key} bust size={size} className={className} label={t(`mascot.names.${key}`)} />;
}

/** Rejilla para elegir compañero (ficha del niño en el panel del tutor y selector del propio niño). */
export function MascotPick({
  value,
  onChange,
  disabled,
}: {
  value: MascotKey;
  onChange: (key: MascotKey) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mascot-pick" role="radiogroup">
      {MASCOT_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={k === value}
          className={"mascot-opt" + (k === value ? " on" : "")}
          disabled={disabled}
          onClick={() => onChange(k)}
        >
          <MascotArt kind={k} className="mascot-opt-art" />
          <span>{t(`mascot.names.${k}`)}</span>
        </button>
      ))}
    </div>
  );
}

const SUIT_LIGHT = "#F4F6FF";
const SUIT_SHADE = "#C4CDF2";
const RIM = "#37E1E8";
const INK = "#1B1430";

const ACCENT: Record<MascotKey, string> = {
  orbi: "#37E1E8",
  redpanda: "#FF8A4D",
  fox: "#FFB04D",
  cat: "#A58BFF",
  bunny: "#FF8FD0",
  panda: "#7EE0A8",
  penguin: "#6FB6FF",
};

/* ---------- Piezas comunes ---------- */

/** Ojo grande y brillante (dos reflejos), el mismo en todos los animales. */
function Eye({ cx, cy, r = 6 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={INK} />
      <circle cx={cx + r * 0.32} cy={cy - r * 0.34} r={r * 0.38} fill="#fff" />
      <circle
        cx={cx - r * 0.36}
        cy={cy + r * 0.36}
        r={r * 0.17}
        fill="#fff"
        opacity="0.85"
      />
    </g>
  );
}

function Blush({ cx, cy }: { cx: number; cy: number }) {
  return (
    <ellipse cx={cx} cy={cy} rx="5.5" ry="3.2" fill="#FF8FA3" opacity="0.55" />
  );
}

/** Traje: tronco, brazos y luz del pecho (por debajo del collar del casco). */
function Suit({ suit, accent }: { suit: string; accent: string }) {
  return (
    <g>
      <rect x="41" y="94" width="58" height="46" rx="23" fill={suit} />
      <rect x="22" y="98" width="27" height="14" rx="7" fill={suit} />
      <rect x="91" y="98" width="27" height="14" rx="7" fill={suit} />
      <circle cx="70" cy="127" r="10.5" fill={accent} opacity="0.2" />
      <circle cx="70" cy="127" r="6.5" fill={accent} />
    </g>
  );
}

/** Casco de cristal sobre la cabeza del animal, con reflejo, collar y antena (guiño a Orbi). */
function Helmet({ suit }: { suit: string }) {
  return (
    <g>
      <circle
        cx="70"
        cy="64"
        r="48"
        fill="#CFF8FF"
        fillOpacity="0.08"
        stroke={RIM}
        strokeWidth="2.5"
      />
      <path
        d="M32.4 50.3A40 40 0 0 1 53.1 27.8"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="61" cy="23.5" r="2.2" fill="#fff" fillOpacity="0.7" />
      <rect
        x="38"
        y="104"
        width="64"
        height="13"
        rx="6.5"
        fill={suit}
        stroke={RIM}
        strokeWidth="2"
      />
      <line
        x1="97"
        y1="26"
        x2="104"
        y2="12"
        stroke="#8FA0D8"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="105" cy="10" r="9" fill="#FFD166" opacity="0.28" />
      <circle cx="105" cy="10" r="5" fill="#FFD166" />
    </g>
  );
}

/* ---------- Animales: lo que va detrás del traje (cola) y la cabeza ---------- */

type Animal = {
  back?: (id: string) => ReactElement;
  head: (id: string) => ReactElement;
  fur: [string, string];
};

const ANIMALS: Record<Exclude<MascotKey, "orbi">, Animal> = {
  redpanda: {
    fur: ["#EC7535", "#C2471B"],
    back: () => (
      <g>
        <path
          d="M92 128C116 137 133 122 127 97"
          fill="none"
          stroke="#D65A22"
          strokeWidth="15"
          strokeLinecap="round"
        />
        <path
          d="M92 128C116 137 133 122 127 97"
          fill="none"
          stroke="#7A2C12"
          strokeWidth="15"
          strokeDasharray="5 7"
          strokeDashoffset="-4"
        />
      </g>
    ),
    head: (id) => (
      <g>
        <path d="M37 58C31 42 35 29 45 27C54 26 60 35 62 45Z" fill="#C9481C" />
        <path d="M42 53C39 42 41 34 46 33C52 33 55 40 56 46Z" fill="#FFF1E2" />
        <path
          d="M103 58C109 42 105 29 95 27C86 26 80 35 78 45Z"
          fill="#C9481C"
        />
        <path d="M98 53C101 42 99 34 94 33C88 33 85 40 84 46Z" fill="#FFF1E2" />
        <ellipse cx="70" cy="73" rx="36" ry="30" fill={`url(#${id}-fur)`} />
        <ellipse cx="55" cy="57" rx="6.5" ry="4" fill="#FFF6EC" />
        <ellipse cx="85" cy="57" rx="6.5" ry="4" fill="#FFF6EC" />
        <ellipse cx="44" cy="84" rx="11" ry="10" fill="#FFF6EC" />
        <ellipse cx="96" cy="84" rx="11" ry="10" fill="#FFF6EC" />
        <ellipse cx="70" cy="88" rx="14" ry="10.5" fill="#FFF6EC" />
        <path
          d="M55 72C55 80 56 88 58 95"
          fill="none"
          stroke="#7A2C12"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <path
          d="M85 72C85 80 84 88 82 95"
          fill="none"
          stroke="#7A2C12"
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <Eye cx={55} cy={67} />
        <Eye cx={85} cy={67} />
        <path
          d="M64.5 81h11c0 4-3 6.5-5.5 7-2.5-.5-5.5-3-5.5-7Z"
          fill="#2A1712"
        />
        <path
          d="M64 92q3 3 6 0q3 3 6 0"
          fill="none"
          stroke="#2A1712"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <Blush cx={44} cy={88} />
        <Blush cx={96} cy={88} />
      </g>
    ),
  },
  fox: {
    fur: ["#FF9A45", "#E8661F"],
    back: () => (
      <g>
        <path
          d="M50 128C30 140 8 128 14 100C18 89 29 91 31 100C29 116 38 122 50 120Z"
          fill="#F07A2E"
        />
        <path
          d="M14 100C18 89 29 91 31 100C25 104 18 104 14 100Z"
          fill="#FFF6EC"
        />
      </g>
    ),
    head: (id) => (
      <g>
        <path d="M36 60C35 46 37 32 41 23C49 29 56 37 62 46Z" fill="#E8661F" />
        <path d="M41 54C41 45 42 37 44 31C49 36 53 41 56 46Z" fill="#FFE8D6" />
        <path
          d="M38.6 31.5C39.3 28.5 40 25.6 41 23C43.7 25 46.2 27.2 48.6 29.5C45 29.2 41.6 30 38.6 31.5Z"
          fill="#3A2218"
        />
        <path
          d="M104 60C105 46 103 32 99 23C91 29 84 37 78 46Z"
          fill="#E8661F"
        />
        <path d="M99 54C99 45 98 37 96 31C91 36 87 41 84 46Z" fill="#FFE8D6" />
        <path
          d="M101.4 31.5C100.7 28.5 100 25.6 99 23C96.3 25 93.8 27.2 91.4 29.5C95 29.2 98.4 30 101.4 31.5Z"
          fill="#3A2218"
        />
        <ellipse cx="70" cy="72" rx="36" ry="29" fill={`url(#${id}-fur)`} />
        <path
          d="M34 76C40 91 56 100 70 102C84 100 100 91 106 76C96 82 84 81 77 74L70 81L63 74C56 81 44 82 34 76Z"
          fill="#FFF6EC"
        />
        <Eye cx={56} cy={66} />
        <Eye cx={84} cy={66} />
        <ellipse cx="70" cy="84" rx="5" ry="3.8" fill="#2A1712" />
        <path
          d="M65 91q2.5 2.5 5 0q2.5 2.5 5 0"
          fill="none"
          stroke="#2A1712"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <Blush cx={47} cy={84} />
        <Blush cx={93} cy={84} />
      </g>
    ),
  },
  cat: {
    fur: ["#B9ADF0", "#8C7DD6"],
    back: () => (
      <path
        d="M96 133C122 138 133 118 126 102C123 95 128 89 134 92"
        fill="none"
        stroke="#9C8FE0"
        strokeWidth="7"
        strokeLinecap="round"
      />
    ),
    head: (id) => (
      <g>
        <path d="M37 60C35 46 37 36 41 27C49 31 56 38 61 46Z" fill="#9C8FE0" />
        <path d="M42 54C41 46 42 39 44 34C48 37 52 41 55 46Z" fill="#FFB3C7" />
        <path
          d="M103 60C105 46 103 36 99 27C91 31 84 38 79 46Z"
          fill="#9C8FE0"
        />
        <path d="M98 54C99 46 98 39 96 34C92 37 88 41 85 46Z" fill="#FFB3C7" />
        <ellipse cx="70" cy="73" rx="36" ry="29" fill={`url(#${id}-fur)`} />
        <path
          d="M63 47v8M70 45.5v10M77 47v8"
          fill="none"
          stroke="#6E5FC0"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <ellipse cx="64" cy="86" rx="7.5" ry="5.8" fill="#F3F0FF" />
        <ellipse cx="76" cy="86" rx="7.5" ry="5.8" fill="#F3F0FF" />
        <Eye cx={56} cy={69} r={6.5} />
        <Eye cx={84} cy={69} r={6.5} />
        <path d="M66.5 80.5h7l-3.5 4Z" fill="#FF7FA0" strokeLinejoin="round" />
        <path
          d="M53 84l-15-2.5M53 88.5l-14 1.5M87 84l15-2.5M87 88.5l14 1.5"
          fill="none"
          stroke="#F3F0FF"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <Blush cx={46} cy={80} />
        <Blush cx={94} cy={80} />
      </g>
    ),
  },
  bunny: {
    fur: ["#FBF8FF", "#DCD3F2"],
    head: (id) => (
      <g>
        <ellipse
          cx="56"
          cy="38"
          rx="8.5"
          ry="18"
          fill="#E8E1F7"
          transform="rotate(-10 56 38)"
        />
        <ellipse
          cx="56"
          cy="39"
          rx="4.2"
          ry="13"
          fill="#FFB3C7"
          transform="rotate(-10 56 39)"
        />
        <path
          d="M80 50C80 40 82 30 88 26C94 22 101 26 103 33C99 31 94 32 91 36C89 40 88 46 88 52Z"
          fill="#E8E1F7"
        />
        <path
          d="M84 48C84 41 86 33 89.5 30C92.5 28 96 28.5 98 30.5C94 31 90.5 34 89 38C88 41 87.5 45 87.5 49Z"
          fill="#FFB3C7"
        />
        <ellipse cx="70" cy="75" rx="35" ry="28" fill={`url(#${id}-fur)`} />
        <Eye cx={56} cy={71} r={6.5} />
        <Eye cx={84} cy={71} r={6.5} />
        <path d="M66.5 82.5h7l-3.5 3.5Z" fill="#FF7FA0" />
        <path
          d="M70 86v3M65 89q2.5 2.5 5 0q2.5 2.5 5 0"
          fill="none"
          stroke="#5B4E7A"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <rect
          x="67"
          y="90.5"
          width="6"
          height="5"
          rx="1.5"
          fill="#fff"
          stroke="#CFC6E6"
          strokeWidth="1"
        />
        <Blush cx={47} cy={83} />
        <Blush cx={93} cy={83} />
      </g>
    ),
  },
  panda: {
    fur: ["#FBFCFF", "#DCE0F0"],
    head: (id) => (
      <g>
        <circle cx="42" cy="46" r="12" fill="#3A4063" />
        <circle cx="98" cy="46" r="12" fill="#3A4063" />
        <circle cx="43" cy="47" r="6" fill="#545B82" />
        <circle cx="97" cy="47" r="6" fill="#545B82" />
        <ellipse cx="70" cy="74" rx="36" ry="30" fill={`url(#${id}-fur)`} />
        <ellipse
          cx="55"
          cy="70"
          rx="8.5"
          ry="11"
          fill="#3A4063"
          transform="rotate(30 55 70)"
        />
        <ellipse
          cx="85"
          cy="70"
          rx="8.5"
          ry="11"
          fill="#3A4063"
          transform="rotate(-30 85 70)"
        />
        <circle cx="56" cy="68.5" r="4.6" fill="#fff" />
        <circle cx="84" cy="68.5" r="4.6" fill="#fff" />
        <circle cx="56.6" cy="69" r="3" fill={INK} />
        <circle cx="84.6" cy="69" r="3" fill={INK} />
        <circle cx="57.6" cy="67.8" r="1.1" fill="#fff" />
        <circle cx="85.6" cy="67.8" r="1.1" fill="#fff" />
        <ellipse cx="70" cy="83" rx="5.5" ry="4" fill="#2A2E45" />
        <path
          d="M64.5 90q2.75 2.75 5.5 0q2.75 2.75 5.5 0"
          fill="none"
          stroke="#2A2E45"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <Blush cx={45} cy={86} />
        <Blush cx={95} cy={86} />
      </g>
    ),
  },
  penguin: {
    fur: ["#56619E", "#2E3566"],
    head: (id) => (
      <g>
        <ellipse cx="70" cy="72" rx="35" ry="32" fill={`url(#${id}-fur)`} />
        <path
          d="M70 60C62 50 45 52 43 69C41 86 55 99 70 99C85 99 99 86 97 69C95 52 78 50 70 60Z"
          fill="#F7F8FF"
        />
        <Eye cx={57} cy={71} />
        <Eye cx={83} cy={71} />
        <path
          d="M62.5 79h15c-2 5.5-5 7.5-7.5 7.5S64.5 84.5 62.5 79Z"
          fill="#FFA53D"
        />
        <path
          d="M62.5 79h15"
          fill="none"
          stroke="#E07F1F"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <Blush cx={50} cy={84} />
        <Blush cx={90} cy={84} />
      </g>
    ),
  },
};

/* ---------- Dibujo ---------- */

export function MascotArt({
  kind,
  className,
  label,
  bust = false,
  size,
}: {
  kind: MascotKey;
  className?: string;
  label?: string;
  bust?: boolean; // recorte redondo de cabeza y hombros, para usarlo como avatar
  size?: number;
}) {
  // Ids de gradiente únicos por instancia: en el selector se pintan varios compañeros a la vez.
  const id = "m" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const accent = ACCENT[kind];
  const suitFill = `url(#${id}-suit)`;
  const animal = kind === "orbi" ? null : ANIMALS[kind];
  return (
    <svg
      className={className}
      viewBox={bust ? "10 2 120 120" : "0 0 140 152"}
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true, focusable: false })}
    >
      <defs>
        <radialGradient id={`${id}-glow`} cx="50%" cy="46%" r="55%">
          <stop offset="0%" stopColor={accent} stopOpacity="0.55" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-suit`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={SUIT_LIGHT} />
          <stop offset="100%" stopColor={SUIT_SHADE} />
        </linearGradient>
        {animal ? (
          <linearGradient id={`${id}-fur`} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor={animal.fur[0]} />
            <stop offset="100%" stopColor={animal.fur[1]} />
          </linearGradient>
        ) : (
          <linearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0B1030" />
            <stop offset="55%" stopColor="#182055" />
            <stop offset="100%" stopColor="#0A0E28" />
          </linearGradient>
        )}
        {bust && (
          <clipPath id={`${id}-clip`}>
            <circle cx="70" cy="62" r="60" />
          </clipPath>
        )}
      </defs>
      <g clipPath={bust ? `url(#${id}-clip)` : undefined}>
      {bust && <circle cx="70" cy="62" r="60" fill={accent} fillOpacity="0.22" />}
      <ellipse cx="70" cy="80" rx="62" ry="62" fill={`url(#${id}-glow)`} />
      {animal ? (
        <>
          {animal.back?.(id)}
          <Suit suit={suitFill} accent={accent} />
          {animal.head(id)}
          <Helmet suit={suitFill} />
        </>
      ) : (
        <>
          <line
            x1="70"
            y1="18"
            x2="70"
            y2="40"
            stroke="#8FA0D8"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <circle cx="70" cy="15" r="13" fill="#FFD166" opacity="0.28" />
          <circle cx="70" cy="15" r="7" fill="#FFD166" />
          <rect x="41" y="94" width="58" height="46" rx="23" fill={suitFill} />
          <rect x="22" y="98" width="27" height="14" rx="7" fill={suitFill} />
          <rect x="91" y="98" width="27" height="14" rx="7" fill={suitFill} />
          <circle cx="70" cy="118" r="7" fill={RIM} />
          <circle cx="70" cy="118" r="11" fill={RIM} opacity="0.2" />
          <circle cx="70" cy="66" r="46" fill={suitFill} />
          <path
            d="M34 60 a36 33 0 0 1 72 0 v9 a36 31 0 0 1 -72 0 z"
            fill={`url(#${id}-visor)`}
            stroke={RIM}
            strokeWidth="2.5"
          />
          <circle cx="56" cy="64" r="8.5" fill="#EAFBFF" />
          <circle cx="84" cy="64" r="8.5" fill="#EAFBFF" />
          <circle cx="57.5" cy="65" r="4.6" fill={RIM} />
          <circle cx="85.5" cy="65" r="4.6" fill={RIM} />
          <circle cx="59.5" cy="62" r="1.7" fill="#fff" />
          <circle cx="87.5" cy="62" r="1.7" fill="#fff" />
          <path
            d="M60 76 q10 8 20 0"
            fill="none"
            stroke={RIM}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </>
      )}
      </g>
    </svg>
  );
}
