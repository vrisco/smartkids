// «Imprimir»: el tutor compone material en papel a partir de un contenido (ficha suelta, path entero, curso
// del catálogo o los fallos pendientes de un niño): ficha de práctica, examen con nota sobre 10, repaso de
// fallos, cálculo rápido, tarjetas de memoria, ejemplos resueltos u hoja «Recuerda». Opciones de dificultad,
// versiones A/B, cuadernillo de varias fichas, diseño compacto, letra y papel; soluciones SIEMPRE al final.
// Todo se carga ANTES de pulsar «Imprimir» (Safari exige imprimir dentro del clic, sin esperas).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, tx, type FullExercise, type PendingScope, type StudyDocMeta, type TutorStudyDoc } from "../../api";
import { decimalSep, operationSolutionText } from "../ColumnOps";
import { Icon } from "../Icon";
import { StudyDocView } from "../studydoc/StudyDocView";
import { KIND_ICON } from "../studydoc/kinds";
import { exercisesToCards, exercisesToRememberDoc, exercisesToWorkedDoc, type AnswerLabels, type ExerciseGroup } from "./fromExercises";
import { notationOf } from "./ExercisePaper";
import { usePrintJob, type PaperSize } from "./PrintShell";
import { fontPtFor, profileFor, type FontChoice } from "./profiles";
import { examPoints, suggestedMinutes } from "./scoring";
import { LEVELS, addHistory, clearHistory, makeVersionB, mulberry32, readHistory, selectQuestions, sheetCode, toPaper, type Level, type Pickable } from "./select";
import { Booklet, CardsPaper, type KeyStyle, type SheetMode, type SheetSection, type SheetSpec } from "./sheets";

type ExType = FullExercise["type"];
const TYPE_ORDER: ExType[] = [
  "multiple_choice",
  "multiple_select",
  "true_false",
  "fill_in_blank",
  "numeric",
  "ordering",
  "matching",
  "step_problem",
  "column_operation",
  "prime_factorization",
];
const COUNTS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
const MAX_PER_JOB = 200;

export type PrintSource =
  | { kind: "skill"; skillId: string; title: string; subjectId: string; gradeBand: string }
  | { kind: "path"; pathId: string; title: string; subjectId: string; gradeBand: string; modules: { skillId: string; title: string; index: number }[] }
  | { kind: "course"; courseId: string; title: string; subjectId: string; gradeBand: string; childId?: string }
  | { kind: "pending"; childId: string; childName: string; gradeBand: string };

type Mode = SheetMode | "cards" | "worked" | "remember";
const MODES: Mode[] = ["practice", "exam", "review", "drill", "cards", "worked", "remember"];

interface PoolItem extends Pickable {
  subjectId: string;
}

interface Prefs {
  mode: Mode;
  count: number;
  compact: boolean;
  workSpace: boolean;
  font: FontChoice;
  paper: PaperSize;
  includeKey: boolean;
  keyStyle: KeyStyle;
  cardsLayout: "duplex" | "fold";
  avoidRecent: boolean;
}
const DEFAULT_PREFS: Prefs = {
  mode: "practice",
  count: 10,
  compact: false,
  workSpace: true,
  font: "auto",
  paper: "A4",
  includeKey: true,
  keyStyle: "simple",
  cardsLayout: "duplex",
  avoidRecent: true,
};
const PREFS_KEY = "sk_print_prefs";
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}
function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* sin almacenamiento */
  }
}

const isDrillable = (ex: FullExercise) =>
  ex.type === "column_operation" || ex.type === "prime_factorization" || (ex.type === "numeric" && !ex.figure && ex.stem.length <= 40);

function sourceKey(s: PrintSource): string {
  return s.kind === "skill" ? `skill:${s.skillId}` : s.kind === "path" ? `path:${s.pathId}` : s.kind === "course" ? `course:${s.courseId}` : `pending:${s.childId}`;
}

export function PrintDialog({ source, docs: docsProp, onClose }: { source: PrintSource; docs?: StudyDocMeta[]; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [pool, setPool] = useState<PoolItem[] | null>(null);
  const [error, setError] = useState(false);
  const [docs, setDocs] = useState<StudyDocMeta[]>(docsProp ?? []);
  const [scopes, setScopes] = useState<PendingScope[] | null>(null);
  const [scope, setScope] = useState<string>("");
  const [prefs, setPrefsState] = useState<Prefs>(() => {
    const p = loadPrefs();
    return source.kind === "pending" ? { ...p, mode: "review" } : p.mode === "review" ? { ...p, mode: "practice" } : p;
  });
  const [types, setTypes] = useState<ExType[]>([]);
  const [levels, setLevels] = useState<Level[]>([...LEVELS]);
  const [versions, setVersions] = useState(false);
  const [sheets, setSheets] = useState(1);
  const [perModule, setPerModule] = useState(false);
  const [keysTogether, setKeysTogether] = useState(true);
  const [pack, setPack] = useState<string[]>([]);
  const [packDocs, setPackDocs] = useState<Record<string, TutorStudyDoc>>({});
  const [history, setHistory] = useState<Set<string>>(() => readHistory(sourceKey(source)));
  const [printedOnce, setPrintedOnce] = useState(false);
  const { print, portal } = usePrintJob();

  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  // Carga del banco según la fuente (todo antes de imprimir).
  useEffect(() => {
    let alive = true;
    const toItems = (list: { templateId: string; hidden: boolean; exercise: FullExercise }[], subjectId: string, module?: PoolItem["module"]) =>
      list.filter((it) => !it.hidden).map((it) => ({ templateId: it.templateId, exercise: it.exercise, subjectId, module }));
    async function load(): Promise<PoolItem[]> {
      if (source.kind === "skill") return toItems(await api.skillExercises(source.skillId), source.subjectId);
      if (source.kind === "path") {
        const lists = await Promise.all(source.modules.map((m) => api.skillExercises(m.skillId)));
        return lists.flatMap((l, i) => toItems(l, source.subjectId, source.modules[i]));
      }
      if (source.kind === "course") {
        const cc = await api.courseContent(source.courseId, source.childId);
        if (alive) setDocs(cc.docs); // los del curso, aunque el panel aún no los hubiera cargado
        const mods = cc.skills.filter((s) => s.exercises > 0);
        const lists = await Promise.all(mods.map((m) => api.skillExercises(m.id)));
        return lists.flatMap((l, i) => toItems(l, source.subjectId, { skillId: mods[i]!.id, title: tx(mods[i]!.nameI18n), index: i }));
      }
      // Fallos pendientes: primero los ámbitos; el de más pendientes, por defecto.
      const res = await api.childPending(source.childId);
      if (!alive) return [];
      const withPending = res.scopes.filter((s) => s.pending > 0);
      setScopes(withPending);
      const first = withPending[0]?.scope ?? "";
      setScope(first);
      return first ? pendingItems(source.childId, first) : [];
    }
    load()
      .then((items) => {
        if (!alive) return;
        setPool(items);
        setTypes(TYPE_ORDER.filter((ty) => items.some((it) => it.exercise.type === ty)));
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  async function pendingItems(childId: string, sc: string): Promise<PoolItem[]> {
    const res = await api.childPending(childId, sc);
    const ids = new Map<string, number>();
    return (res.items ?? []).map((it) => {
      if (!ids.has(it.skillId)) ids.set(it.skillId, ids.size);
      return {
        templateId: it.templateId,
        exercise: it.exercise,
        subjectId: it.subjectId ?? "math",
        failCount: it.fails,
        module: { skillId: it.skillId, title: tx(it.skillName), index: ids.get(it.skillId)! },
      };
    });
  }

  function changeScope(sc: string) {
    if (source.kind !== "pending") return;
    setScope(sc);
    setPool(null);
    pendingItems(source.childId, sc)
      .then((items) => {
        setPool(items);
        setTypes(TYPE_ORDER.filter((ty) => items.some((it) => it.exercise.type === ty)));
      })
      .catch(() => setError(true));
  }

  // Documentos del «pack de estudio»: se cargan al marcarlos (antes de imprimir).
  function togglePack(id: string, on: boolean) {
    setPack((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
    if (on && !packDocs[id]) api.tutorStudyDoc(id).then((d) => setPackDocs((m) => ({ ...m, [id]: d }))).catch(() => undefined);
  }

  const gradeBand = source.gradeBand;
  const baseProfile = profileFor(source.kind === "pending" ? (pool?.[0]?.subjectId ?? "math") : source.subjectId, gradeBand);
  const title = source.kind === "pending" ? t("print.reviewTitle", { name: source.childName }) : source.title;
  const modules = useMemo(() => {
    const m = new Map<number, string>();
    for (const it of pool ?? []) if (it.module) m.set(it.module.index, it.module.title);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [pool]);

  const perType = useMemo(() => {
    const m = new Map<ExType, number>();
    for (const it of pool ?? []) m.set(it.exercise.type, (m.get(it.exercise.type) ?? 0) + 1);
    return m;
  }, [pool]);
  const perLevel = useMemo(() => {
    const m = new Map<Level, number>();
    for (const it of pool ?? []) if (types.includes(it.exercise.type)) m.set(it.exercise.difficulty.level, (m.get(it.exercise.difficulty.level) ?? 0) + 1);
    return m;
  }, [pool, types]);

  const mode = prefs.mode;
  const exMode = mode === "practice" || mode === "exam" || mode === "review" || mode === "drill";
  const usable = (pool ?? []).filter((it) => types.includes(it.exercise.type) && levels.includes(it.exercise.difficulty.level) && (mode !== "drill" || isDrillable(it.exercise)));
  const available = usable.length;
  const nSheets = perModule && modules.length > 1 ? modules.length : sheets;
  const perSheet = Math.max(0, Math.min(prefs.count, available, Math.floor(MAX_PER_JOB / Math.max(1, nSheets * (versions ? 2 : 1)))));
  const recent = usable.filter((it) => history.has(it.templateId)).length;

  const availableModes = MODES.filter((m) => {
    if (m === "review") return source.kind === "pending";
    if (m === "drill") return (pool ?? []).some((it) => isDrillable(it.exercise));
    if (m === "worked") return (pool ?? []).some((it) => it.exercise.feedback?.solution || it.exercise.type === "column_operation" || it.exercise.type === "prime_factorization");
    if (m === "remember") return (pool ?? []).some((it) => it.exercise.feedback?.theory);
    return true;
  });

  const labels: AnswerLabels = {
    yes: t("session.true"),
    no: t("session.false"),
    opText: (ex) => operationSolutionText(ex, decimalSep(i18n.language), t("session.remainder").toLowerCase()),
    decimal: decimalSep(i18n.language),
  };

  /** Agrupa por módulo (secciones con título si hay varios). */
  function sectionsOf(items: PoolItem[], rng: () => number): SheetSection[] {
    const groups = new Map<number, PoolItem[]>();
    for (const it of items) groups.set(it.module?.index ?? 0, [...(groups.get(it.module?.index ?? 0) ?? []), it]);
    const multi = groups.size > 1;
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, list]) => ({
        title: multi ? (list[0]?.module?.title ?? null) : null,
        profile: profileFor(list[0]?.subjectId ?? baseProfile.family, gradeBand),
        questions: list.map((it) => toPaper(it, rng)),
      }));
  }

  function buildExerciseJob(): { node: ReactNode; ids: string[] } {
    const rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    const avoid = prefs.avoidRecent ? history : new Set<string>();
    const used = new Set<string>();
    const specs: SheetSpec[] = [];
    const sheetMode = mode as SheetMode;
    const order = mode === "review" ? "fails" : modules.length > 1 && !perModule ? "module" : "difficulty";
    for (let i = 0; i < nSheets; i++) {
      const base = perModule && modules.length > 1 ? usable.filter((it) => it.module?.index === modules[i]?.[0]) : usable;
      const picked = selectQuestions(base, { n: perSheet, types, levels, rng, avoid, exclude: used, order });
      picked.forEach((it) => used.add(it.templateId));
      const variants: { items: PoolItem[]; version?: string }[] = [{ items: picked, version: versions ? "A" : undefined }];
      if (versions) {
        const b = makeVersionB(picked, base, rng);
        b.items.forEach((it) => used.add(it.templateId));
        variants.push({ items: b.items, version: "B" });
      }
      for (const v of variants) {
        const sections = sectionsOf(v.items, rng);
        const flat = sections.flatMap((s) => s.questions.map((q) => q.ex));
        const sheetTitle = perModule && modules.length > 1 ? `${title} · ${modules[i]?.[1] ?? ""}` : nSheets > 1 ? `${title} · ${t("print.sheetN", { n: i + 1 })}` : title;
        specs.push({
          title: sheetTitle,
          kicker: t(`print.mode_${mode}`),
          meta: [t(`grades.${gradeBand}`, { defaultValue: "" })].filter(Boolean),
          mode: sheetMode,
          sections,
          workSpace: prefs.workSpace,
          compact: prefs.compact,
          fontPt: fontPtFor(baseProfile, prefs.font),
          points: mode === "exam" ? examPoints(flat) : undefined,
          minutes: mode === "exam" ? suggestedMinutes(flat, baseProfile.age) : undefined,
          code: sheetCode(rng),
          version: v.version,
          remember: mode === "review",
        });
      }
    }
    return {
      node: <Booklet sheets={specs} keyStyle={mode === "review" ? "explained" : prefs.keyStyle} includeKey={prefs.includeKey} keysTogether={keysTogether} />,
      ids: [...used],
    };
  }

  function groupsOf(items: PoolItem[]): ExerciseGroup[] {
    const g = new Map<number, PoolItem[]>();
    for (const it of items) g.set(it.module?.index ?? 0, [...(g.get(it.module?.index ?? 0) ?? []), it]);
    const multi = g.size > 1;
    return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => ({ title: multi ? (list[0]?.module?.title ?? null) : null, exercises: list.map((it) => it.exercise) }));
  }

  function generate() {
    const font = fontPtFor(baseProfile, prefs.font);
    const notation = notationOf(baseProfile);
    let main: ReactNode = null;
    let ids: string[] = [];
    if (exMode) {
      const job = buildExerciseJob();
      main = job.node;
      ids = job.ids;
    } else {
      const rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
      const picked = mode === "remember" ? usable : selectQuestions(usable, { n: perSheet, types, levels, rng, avoid: prefs.avoidRecent ? history : undefined, order: "module" });
      ids = picked.map((it) => it.templateId);
      if (mode === "cards") {
        main = (
          <div style={{ ["--ws-font" as string]: `${font}pt` }}>
            <CardsPaper title={title} cards={exercisesToCards(picked.map((it) => it.exercise), labels)} layout={prefs.cardsLayout} frontNotation={notation} backNotation={notation} />
          </div>
        );
      } else {
        const doc =
          mode === "worked"
            ? exercisesToWorkedDoc(groupsOf(picked), `${title} · ${t("print.mode_worked")}`, labels)
            : exercisesToRememberDoc(groupsOf(picked), `${title} · ${t("print.mode_remember")}`);
        main = <StudyDocView doc={doc} medium="paper" profile={baseProfile} notation={notation} fontPt={font} />;
      }
    }
    const packNodes = pack
      .map((id) => packDocs[id])
      .filter((d): d is TutorStudyDoc => Boolean(d))
      .map((d) => (
        <div className="ws-pack-doc" key={d.id}>
          <StudyDocView doc={d.body} medium="paper" profile={profileFor(d.subjectId, d.gradeBand)} fontPt={font} cardsLayout={prefs.cardsLayout} />
        </div>
      ));
    print(
      <>
        {packNodes}
        <div className={packNodes.length > 0 ? "ws-page-break" : undefined}>{main}</div>
      </>,
      { fileName: `${title} - ${t(`print.mode_${mode}`)}`, paper: prefs.paper, headerText: title },
    );
    if (exMode || mode === "cards" || mode === "worked") {
      addHistory(sourceKey(source), ids);
      setHistory(readHistory(sourceKey(source)));
    }
    setPrintedOnce(true);
  }

  function toggleType(ty: ExType, on: boolean) {
    setTypes((cur) => (on ? TYPE_ORDER.filter((x) => x === ty || cur.includes(x)) : cur.filter((x) => x !== ty)));
  }
  function toggleLevel(l: Level, on: boolean) {
    setLevels((cur) => (on ? LEVELS.filter((x) => x === l || cur.includes(x)) : cur.filter((x) => x !== l)));
  }

  const countOptions = [...new Set([...COUNTS.filter((c) => c < available), Math.min(available, MAX_PER_JOB), prefs.count])]
    .filter((v) => v > 0 && v <= Math.max(available, 1))
    .sort((a, b) => a - b);
  const packable = docs;
  const ready = pool !== null && (mode === "remember" ? available > 0 : perSheet > 0) && pack.every((id) => packDocs[id]);

  const summary =
    !exMode
      ? t(`print.mode_${mode}Hint`)
      : t("print.summaryLine", { sheets: nSheets * (versions ? 2 : 1), count: perSheet }) + (prefs.includeKey ? ` · ${t("print.withKey")}` : "");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal print-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <div className="list-main">
            <b>
              <Icon name="printer" size={16} /> {t("print.title")}
            </b>
            <span className="muted">{title}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {error ? (
          <p className="muted screen-pad">{t("session.connError")}</p>
        ) : pool === null ? (
          <p className="muted screen-pad">{t("content.previewLoading")}</p>
        ) : (
          <>
            {source.kind === "pending" && scopes && (
              <label className="form-cell">
                <span className="course-label">{t("print.scope")}</span>
                {scopes.length === 0 ? (
                  <p className="muted">{t("print.noPending")}</p>
                ) : (
                  <select className="field" value={scope} onChange={(e) => changeScope(e.target.value)}>
                    {scopes.map((s) => (
                      <option key={s.scope} value={s.scope}>
                        {(tx(s.label) || s.scope) + " · " + t("print.pendingN", { count: s.pending })}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}

            {pool.length === 0 ? (
              <p className="muted screen-pad">{t("worksheet.empty")}</p>
            ) : (
              <>
                <div className="course-label">{t("print.mode")}</div>
                <div className="print-modes">
                  {availableModes.map((m) => (
                    <label className={"course-check option-card" + (mode === m ? " on" : "")} key={m}>
                      <input type="radio" name="print-mode" checked={mode === m} onChange={() => setPrefs({ mode: m })} />
                      <span className="option-text">
                        <b>{t(`print.mode_${m}`)}</b>
                        <span>{t(`print.mode_${m}Hint`)}</span>
                      </span>
                    </label>
                  ))}
                </div>

                {mode !== "remember" && (
                  <>
                    <div className="course-label">{t("worksheet.types")}</div>
                    <div className="type-checks">
                      {TYPE_ORDER.filter((ty) => perType.has(ty)).map((ty) => {
                        const on = types.includes(ty);
                        return (
                          <label className={"course-check option-card" + (on ? " on" : "")} key={ty}>
                            <input type="checkbox" checked={on} onChange={(e) => toggleType(ty, e.target.checked)} />
                            <span className="option-text">
                              <b>{t(`content.qt_${ty}`)}</b>
                              <span>{t("worksheet.inBank", { count: perType.get(ty) })}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>

                    <div className="course-label">{t("print.difficulty")}</div>
                    <div className="type-checks three">
                      {LEVELS.map((l) => (
                        <label className={"course-check option-card" + (levels.includes(l) ? " on" : "")} key={l}>
                          <input type="checkbox" checked={levels.includes(l)} onChange={(e) => toggleLevel(l, e.target.checked)} />
                          <span className="option-text">
                            <b>{t(`print.lvl_${l}`)}</b>
                            <span>{t("worksheet.inBank", { count: perLevel.get(l) ?? 0 })}</span>
                          </span>
                        </label>
                      ))}
                    </div>

                    <div className="form-grid">
                      <label className="form-cell">
                        <span className="course-label">{mode === "cards" ? t("print.cardsCount") : t("worksheet.numQuestions")}</span>
                        <select className="field" value={perSheet || ""} disabled={available === 0} onChange={(e) => setPrefs({ count: Number(e.target.value) })}>
                          {countOptions.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </label>
                      {exMode && (
                        <label className="form-cell">
                          <span className="course-label">{t("print.sheets")}</span>
                          <select className="field" value={sheets} disabled={perModule} onChange={(e) => setSheets(Number(e.target.value))}>
                            {[1, 2, 3, 4, 5, 6].map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                    <p className="reward-hint">
                      {available === 0 ? t("worksheet.noTypes") : t("worksheet.available", { count: available })}
                      {prefs.avoidRecent && recent > 0 && ` ${t("print.recentN", { count: recent })}`}
                    </p>
                  </>
                )}

                <div className="course-label">{t("print.format")}</div>
                <div className="type-checks">
                  {exMode && (
                    <>
                      <Check on={prefs.workSpace} set={(v) => setPrefs({ workSpace: v })} title={t("worksheet.workSpace")} hint={t(`print.workSpaceHint_${baseProfile.family}`, { defaultValue: t("worksheet.workSpaceHint") })} />
                      <Check on={prefs.compact} set={(v) => setPrefs({ compact: v })} title={t("print.compact")} hint={t("print.compactHint")} />
                      <Check on={prefs.includeKey} set={(v) => setPrefs({ includeKey: v })} title={t("print.includeKey")} hint={t("print.includeKeyHint")} />
                      {mode !== "review" && (
                        <Check
                          on={prefs.keyStyle === "explained"}
                          set={(v) => setPrefs({ keyStyle: v ? "explained" : "simple" })}
                          title={t("print.keyExplained")}
                          hint={t("print.keyExplainedHint")}
                        />
                      )}
                    </>
                  )}
                </div>
                <div className="form-grid">
                  <label className="form-cell">
                    <span className="course-label">{t("print.fontSize")}</span>
                    <select className="field" value={prefs.font} onChange={(e) => setPrefs({ font: e.target.value as FontChoice })}>
                      {(["auto", "normal", "large", "xlarge"] as const).map((f) => (
                        <option key={f} value={f}>
                          {t(`print.font_${f}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-cell">
                    <span className="course-label">{t("print.paper")}</span>
                    <select className="field" value={prefs.paper} onChange={(e) => setPrefs({ paper: e.target.value as PaperSize })}>
                      <option value="A4">{t("print.paper_a4")}</option>
                      <option value="letter">{t("print.paper_letter")}</option>
                    </select>
                  </label>
                  {mode === "cards" && (
                    <label className="form-cell">
                      <span className="course-label">{t("print.cardsLayout")}</span>
                      <select className="field" value={prefs.cardsLayout} onChange={(e) => setPrefs({ cardsLayout: e.target.value as "duplex" | "fold" })}>
                        <option value="duplex">{t("print.duplex")}</option>
                        <option value="fold">{t("print.fold")}</option>
                      </select>
                    </label>
                  )}
                </div>

                <details className="print-more">
                  <summary>{t("print.more")}</summary>
                  <div className="type-checks">
                    {(mode === "exam" || mode === "drill" || mode === "practice") && (
                      <Check on={versions} set={setVersions} title={t("print.versions")} hint={t("print.versionsHint")} />
                    )}
                    {exMode && modules.length > 1 && <Check on={perModule} set={setPerModule} title={t("print.perModule")} hint={t("print.perModuleHint", { count: modules.length })} />}
                    {exMode && nSheets > 1 && prefs.includeKey && (
                      <Check on={keysTogether} set={setKeysTogether} title={t("print.keysTogether")} hint={t("print.keysTogetherHint")} />
                    )}
                    <Check on={prefs.avoidRecent} set={(v) => setPrefs({ avoidRecent: v })} title={t("print.avoidRecent")} hint={t("print.avoidRecentHint")} />
                  </div>
                  {history.size > 0 && (
                    <button
                      className="btn-ghost sm"
                      type="button"
                      onClick={() => {
                        clearHistory(sourceKey(source));
                        setHistory(new Set());
                      }}
                    >
                      {t("print.forgetHistory")}
                    </button>
                  )}
                  {packable.length > 0 && (
                    <>
                      <div className="course-label">{t("print.pack")}</div>
                      <p className="reward-hint">{t("print.packHint")}</p>
                      <div className="type-checks">
                        {packable.map((d) => (
                          <label className={"course-check option-card" + (pack.includes(d.id) ? " on" : "")} key={d.id}>
                            <input type="checkbox" checked={pack.includes(d.id)} onChange={(e) => togglePack(d.id, e.target.checked)} />
                            <span className="option-text">
                              <b>
                                <Icon name={KIND_ICON[d.kind]} size={14} /> {t(`studydoc.kind_${d.kind}`)}
                              </b>
                              <span>{d.title}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </details>

                <p className="reward-hint">{summary}</p>
                <p className="reward-hint">{mode === "cards" && prefs.cardsLayout === "duplex" ? t("print.duplexTip") : t("print.browserTip")}</p>
              </>
            )}
          </>
        )}

        {printedOnce && <div className="auth-info">{t("worksheet.again")}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" type="button" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn-primary" type="button" onClick={generate} disabled={!ready}>
            <Icon name="printer" size={16} /> {t("print.print")}
          </button>
        </div>
      </div>
      {portal}
    </div>
  );
}

function Check({ on, set, title, hint }: { on: boolean; set: (v: boolean) => void; title: string; hint: string }) {
  return (
    <label className={"course-check option-card" + (on ? " on" : "")}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="option-text">
        <b>{title}</b>
        <span>{hint}</span>
      </span>
    </label>
  );
}

