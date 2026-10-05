// «Apuntes» del niño: sus resúmenes, hojas de trucos, tarjetas... agrupados por curso o tema, y el lector a
// pantalla completa (letra más grande o más pequeña, tarjetas que se giran, soluciones tras pulsar).
import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, tx, type ChildStudyDoc, type ChildStudyDocMeta, type Course, type CustomContent } from "../api";
import { Icon } from "./Icon";
import { profileFor } from "./print/profiles";
import { KIND_ICON } from "./studydoc/kinds";

// El lector solo se carga al abrir un apunte (la lista y la tira no lo necesitan).
const StudyDocView = lazy(() => import("./studydoc/StudyDocView").then((m) => ({ default: m.StudyDocView })));

export interface NotesGroup {
  key: string;
  title: string;
  docs: ChildStudyDocMeta[];
}

/** Agrupa los apuntes: por curso, por path, por ficha y el resto. */
export function groupNotes(docs: ChildStudyDocMeta[], courses: Course[], custom: CustomContent[], otherLabel: string): NotesGroup[] {
  const groups = new Map<string, NotesGroup>();
  const add = (key: string, title: string, d: ChildStudyDocMeta) => {
    const g = groups.get(key) ?? { key, title, docs: [] };
    g.docs.push(d);
    groups.set(key, g);
  };
  for (const d of docs) {
    if (d.pathId) add("path:" + d.pathId, tx(d.pathName) || otherLabel, d);
    else if (d.skillId && d.origin === "private") {
      const cc = custom.find((c) => c.skillId === d.skillId);
      add("skill:" + d.skillId, cc ? tx(cc.nameI18n) : otherLabel, d);
    } else if (d.courseIds.length > 0) {
      const co = courses.find((c) => c.id === d.courseIds[0]);
      add("course:" + d.courseIds[0], co ? tx(co.nameI18n) : otherLabel, d);
    } else add(d.requestId ? "req:" + d.requestId : "other", otherLabel, d);
  }
  return [...groups.values()];
}

function NoteCard({ d, onOpen }: { d: ChildStudyDocMeta; onOpen: (d: ChildStudyDocMeta) => void }) {
  const { t } = useTranslation();
  return (
    <button className="course-card note-card" type="button" onClick={() => onOpen(d)}>
      <span className="course-emoji">
        <Icon name={KIND_ICON[d.kind]} size={20} />
      </span>
      <span className="course-text">
        <b>{d.title}</b>
        <span className="course-sub">
          {t(`studydoc.kind_${d.kind}`)}
          {d.stats?.cards ? ` · ${t("studydoc.cardsN", { count: d.stats.cards })}` : ""}
        </span>
      </span>
    </button>
  );
}

export function NotesSection({ groups, onOpen }: { groups: NotesGroup[]; onOpen: (d: ChildStudyDocMeta) => void }) {
  const { t } = useTranslation();
  if (groups.length === 0) return null;
  return (
    <>
      <div className="screen-kicker" style={{ paddingTop: "1.4rem" }}>
        {t("kid.notes")}
      </div>
      {groups.map((g) => (
        <div className="notes-group" key={g.key}>
          {groups.length > 1 && <div className="notes-group-title">{g.title}</div>}
          <div className="course-grid">
            {g.docs.map((d) => (
              <NoteCard key={d.id} d={d} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Tira compacta «Apuntes de este tema» (en un path o en la galaxia de un curso). */
export function NotesStrip({ docs, onOpen }: { docs: ChildStudyDocMeta[]; onOpen: (d: ChildStudyDocMeta) => void }) {
  const { t } = useTranslation();
  if (docs.length === 0) return null;
  return (
    <div className="notes-strip">
      <span className="notes-strip-label">
        <Icon name="book" size={14} /> {t("kid.notesTopic")}
      </span>
      {docs.map((d) => (
        <button className="note-chip" type="button" key={d.id} onClick={() => onOpen(d)}>
          <Icon name={KIND_ICON[d.kind]} size={14} /> {d.title}
        </button>
      ))}
    </div>
  );
}

const FONT_KEY = "sk_doc_font";
const SCALES = [0.9, 1, 1.15, 1.3, 1.5];
function readScale(): number {
  try {
    const v = Number(localStorage.getItem(FONT_KEY));
    return SCALES.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

/** Lector a pantalla completa de un apunte. */
export function NotesReader({ meta, onClose }: { meta: ChildStudyDocMeta; onClose: () => void }) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<ChildStudyDoc | null>(null);
  const [error, setError] = useState(false);
  const [scale, setScale] = useState(readScale);

  useEffect(() => {
    api
      .childStudyDoc(meta.id)
      .then(setDoc)
      .catch(() => setError(true));
  }, [meta.id]);

  function bump(dir: 1 | -1) {
    const i = Math.max(0, Math.min(SCALES.length - 1, SCALES.indexOf(scale) + dir));
    const next = SCALES[i]!;
    setScale(next);
    try {
      localStorage.setItem(FONT_KEY, String(next));
    } catch {
      /* sin almacenamiento: solo esta vez */
    }
  }

  return (
    <div className="notes-reader">
      <div className="notes-bar">
        <button className="btn-ghost sm" type="button" onClick={onClose}>
          <Icon name="back" size={14} /> {t("common.back")}
        </button>
        <b className="notes-bar-title">{meta.title}</b>
        <div className="notes-font">
          <button className="icon-btn" type="button" onClick={() => bump(-1)} aria-label={t("studydoc.fontSmaller")} disabled={scale === SCALES[0]}>
            A-
          </button>
          <button className="icon-btn" type="button" onClick={() => bump(1)} aria-label={t("studydoc.fontBigger")} disabled={scale === SCALES[SCALES.length - 1]}>
            A+
          </button>
        </div>
      </div>
      <div className="notes-body" style={{ ["--sd-scale" as string]: String(scale) }}>
        {error ? (
          <p className="muted screen-pad">{t("studydoc.loadError")}</p>
        ) : !doc ? (
          <p className="muted screen-pad">{t("studydoc.loading")}</p>
        ) : (
          <Suspense fallback={null}>
            <StudyDocView doc={doc.doc} medium="screen" profile={profileFor(doc.subjectId, doc.gradeBand)} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
