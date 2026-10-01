import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type Answer, type AttemptResult, type Exercise, type ReportReason } from "../api";
import { ExerciseInput, FillBlanks, correctAnswerString } from "../components/ExerciseInput";
import { ExerciseFigure } from "../components/ExerciseFigure";
import { Icon } from "../components/Icon";
import { MathText } from "../components/MathText";
import { Mascot, MascotContext } from "../components/Mascot";
import { keepAwake, vibrate } from "../pwa";

const DEFAULT_SESSION_LENGTH = 5; // si el servidor no dice otra cosa (skills antiguos)
const MAX_DOTS = 12; // a partir de aquí, barra de progreso en vez de puntos (misiones largas)
const REVIEW_EXTRA = 3; // margen de reintentos sobre el nº de fallos, para no frustrar

type Phase = "main" | "reviewIntro" | "review" | "summary";
const REPORT_REASONS: ReportReason[] = ["wrong_answer", "unclear", "other"];

/** Baraja una copia (Fisher-Yates): el repaso no sigue el orden en que se fallaron. */
function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function Session({
  profileId,
  skillId,
  onBalance,
  onExit,
}: {
  profileId: string;
  skillId: string;
  onBalance: (balance: number) => void;
  onExit: () => void;
}) {
  const { t } = useTranslation();
  const mascot = useContext(MascotContext);
  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [phase, setPhase] = useState<Phase>("main");
  const [sessionLength, setSessionLength] = useState<number | null>(null); // preguntas de la tanda (lo fija el skill)
  const [mainDone, setMainDone] = useState(0);
  const [mainCorrect, setMainCorrect] = useState(0);
  const [failedIds, setFailedIds] = useState<string[]>([]); // ejercicios fallados en la tanda principal
  const [reviewQueue, setReviewQueue] = useState<string[]>([]); // ids pendientes de repasar (los fallados)
  const [reviewBudget, setReviewBudget] = useState(0); // tope de reintentos de repaso
  const [reviewFixed, setReviewFixed] = useState(0); // fallados que se acertaron en el repaso
  const [hintsShown, setHintsShown] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [error, setError] = useState<null | "red" | "permanente">(null); // fallo al CARGAR: de red (reintentable) o definitivo
  const [submitError, setSubmitError] = useState(false); // fallo al ENVIAR: el ejercicio sigue en pantalla
  const [submitting, setSubmitting] = useState(false);
  const served = useRef<string[]>([]);
  const attemptId = useRef<string>(""); // id idempotente del intento en curso (uno por ejercicio servido)
  const lastRun = useRef<(() => Promise<Exercise>) | null>(null); // última carga, para poder reintentarla
  const cargaId = useRef(0); // generación de carga: descarta respuestas de peticiones ya superadas

  // Reset común al recibir un ejercicio (nuevo o reintentado).
  // Recibe un THUNK, no una promesa ya lanzada, para poder REPETIR la petición al reintentar.
  const applyExercise = useCallback((run: () => Promise<Exercise>) => {
    lastRun.current = run;
    const gen = ++cargaId.current; // si el niño pulsa Reintentar dos veces, solo cuenta la última
    setError(null); // sin esto el flag se quedaba puesto para siempre y encerraba al niño
    setSubmitError(false);
    setAnswer(null);
    setResult(null);
    setExercise(null);
    setHintsShown(0);
    void (async () => {
      // Un microcorte de red no debe romper la misión: reintentamos como ya hace el envío.
      for (let tryN = 0; tryN < 3; tryN++) {
        try {
          const ex = await run();
          if (gen !== cargaId.current) return; // llegó tarde: ya hay otra carga en curso
          // La longitud de la misión la decide el skill (llega con el primer ejercicio y no cambia).
          if (ex.sessionLength) setSessionLength((cur) => cur ?? ex.sessionLength ?? null);
          setExercise(ex);
          attemptId.current = crypto.randomUUID();
          setStartedAt(Date.now());
          return;
        } catch (e) {
          if (gen !== cargaId.current) return;
          const esRed = e instanceof ApiError && e.kind === "network";
          if (esRed && tryN < 2) {
            await new Promise((r) => setTimeout(r, 600 * (tryN + 1)));
            continue;
          }
          // Un 403/404/500 no se arregla reintentando: ofrecer "Volver a intentarlo" sería
          // mentirle al niño y, en fase de repaso, dejarlo dando vueltas sin terminar la misión.
          setError(esRed ? "red" : "permanente");
          return;
        }
      }
    })();
  }, []);
  const loadNext = useCallback(
    () => applyExercise(() => api.nextExercise(skillId, profileId, served.current)),
    [applyExercise, skillId, profileId],
  );
  const loadId = useCallback((id: string) => applyExercise(() => api.retryExercise(id, profileId)), [applyExercise, profileId]);
  const retryLoad = useCallback(() => {
    if (lastRun.current) applyExercise(lastRun.current);
  }, [applyExercise]);

  useEffect(() => {
    loadNext();
  }, [loadNext]);

  // Mantén la pantalla encendida mientras dura la sesión (se libera al salir).
  useEffect(() => keepAwake(), []);

  async function submit() {
    if (!exercise || !answer || result || submitting) return;
    const payload = { profileId, exerciseTemplateId: exercise.id, answer, responseTimeMs: Date.now() - startedAt, clientAttemptId: attemptId.current };
    setSubmitting(true);
    setSubmitError(false);
    // Ante un microcorte de red reintentamos con el MISMO clientAttemptId (el servidor lo deduplica).
    for (let tryN = 0; tryN < 3; tryN++) {
      try {
        const res = await api.attempt(payload);
        onBalance(res.balance);
        served.current = [...served.current, exercise.id];
        setResult(res);
        vibrate(res.correct ? 30 : [40, 60, 40]); // háptico: acierto corto, fallo doble
        setSubmitting(false);
        return;
      } catch (e) {
        if (e instanceof ApiError && e.kind === "network" && tryN < 2) {
          await new Promise((r) => setTimeout(r, 600 * (tryN + 1)));
          continue;
        }
        setSubmitting(false);
        // NO tiramos la pantalla: el ejercicio y la respuesta del niño siguen ahí y puede reintentar.
        setSubmitError(true);
        return;
      }
    }
  }

  const total = sessionLength ?? DEFAULT_SESSION_LENGTH;

  function startReview() {
    const queue = shuffled([...new Set(failedIds)]);
    setPhase("review");
    setReviewQueue(queue);
    setReviewBudget(queue.length + REVIEW_EXTRA);
    setReviewFixed(0);
    loadId(queue[0]!);
  }

  function advance() {
    if (!result || !exercise) return;
    const ok = result.correct;
    if (phase === "main") {
      const nd = mainDone + 1;
      const failed = ok ? failedIds : [...failedIds, exercise.id];
      setMainDone(nd);
      setFailedIds(failed);
      if (ok) setMainCorrect((n) => n + 1);
      if (nd >= total) {
        // Fin de la tanda: si hubo fallos, pantalla de transición y SESIÓN DE REPASO con esos mismos
        // ejercicios (barajados); si no, directamente el resumen.
        setPhase(failed.length > 0 ? "reviewIntro" : "summary");
        return;
      }
      loadNext();
    } else if (phase === "review") {
      // Repaso: acertar saca el ejercicio de la cola; fallar lo manda al final para reintentarlo.
      const rest = reviewQueue.filter((id) => id !== exercise.id);
      const queue = ok ? rest : [...rest, exercise.id];
      const budget = reviewBudget - 1;
      if (ok) setReviewFixed((n) => n + 1);
      if (queue.length === 0 || budget <= 0) {
        setPhase("summary");
        return;
      }
      setReviewQueue(queue);
      setReviewBudget(budget);
      loadId(queue[0]!);
    }
  }

  // Transición al repaso y resumen final: pantallas propias, sin ejercicio en curso.
  if (phase === "reviewIntro" || phase === "summary") {
    const failedCount = new Set(failedIds).size;
    return (
      <div className="session-screen">
        <div className="session-top">
          <button className="icon-btn" onClick={onExit} aria-label={t("session.exitMission")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="session-state">
          <Mascot className="session-state-orbi float" />
          {phase === "reviewIntro" ? (
            <>
              <h2 className="session-state-title">{t("session.reviewIntroTitle")}</h2>
              <p className="session-state-text">{t("session.reviewIntroBody", { correct: mainCorrect, total, count: failedCount })}</p>
              <button className="btn-primary" onClick={startReview}>
                <Icon name="target" size={16} /> {t("session.startReview")}
              </button>
            </>
          ) : (
            <>
              <h2 className="session-state-title">{t("session.summaryTitle")}</h2>
              {failedCount === 0 ? (
                <p className="session-state-text">{t("session.summaryPerfect", { correct: mainCorrect, total })}</p>
              ) : (
                <>
                  <p className="session-state-text">{t("session.summaryFirst", { correct: mainCorrect, total })}</p>
                  <p className="session-state-text">{t("session.summaryReview", { fixed: Math.min(reviewFixed, failedCount), count: failedCount })}</p>
                  <p className="session-state-text">{t("session.summaryPending")}</p>
                </>
              )}
              <button className="btn-primary" onClick={onExit}>
                {t("session.backHome")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // Ni el error ni la carga pueden dejar al niño sin salida: se pintan DENTRO del layout de
  // sesión, que es donde vive el botón de cerrar (antes había un early return que lo escondía
  // y la sesión ocupa la pantalla completa, sin HUD ni barra inferior: no había forma de salir).
  if (error !== null || !exercise) {
    return (
      <div className="session-screen">
        <div className="session-top">
          <button className="icon-btn" onClick={onExit} aria-label={t("session.exitMission")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="session-state">
          {error !== null ? (
            <>
              <Mascot className="session-state-orbi float" />
              <p className="session-state-text">{error === "red" ? t("session.missionOffline") : t("session.missionFailed")}</p>
              {error === "red" ? (
                <button className="btn-primary" onClick={retryLoad}>
                  <Icon name="play" size={16} /> {t("session.connRetry")}
                </button>
              ) : (
                <button className="btn-primary" onClick={loadNext}>
                  <Icon name="play" size={16} /> {t("session.next")}
                </button>
              )}
              <button className="btn-ghost" onClick={onExit}>
                {t("session.exitMission")}
              </button>
            </>
          ) : (
            <p className="session-state-text muted">{t("session.loadingMission")}</p>
          )}
        </div>
      </div>
    );
  }

  const render = exercise.render;
  const qk =
    render.type === "true_false"
      ? t("session.trueOrFalse")
      : render.type === "ordering"
        ? t("session.order")
        : render.type === "matching"
          ? t("session.match")
          : render.type === "fill_in_blank"
            ? t("session.complete")
            : render.type === "multiple_select"
              ? t("session.selectAll")
              : t("session.solve");

  // En selección / verdadero-falso / casillas la respuesta buena ya se marca en verde sobre las opciones.
  const highlighted = render.type === "multiple_choice" || render.type === "true_false" || render.type === "multiple_select";
  const failed = Boolean(result && !result.correct);
  const correctText = failed && result?.correctAnswer && !highlighted ? correctAnswerString(render, result.correctAnswer) : "";
  const showExplain = failed && Boolean(correctText || result?.theory || result?.solution);

  const hints = exercise.hints ?? [];

  // ¿El botón cierra una fase (fin de tanda o fin del repaso)? Simula la transición de `advance()`.
  let willFinish = false;
  if (result) {
    if (phase === "main") {
      // Con fallos, tras la última pregunta viene el repaso: el botón no "termina" nada todavía.
      willFinish = mainDone + 1 >= total && (result.correct ? failedIds.length : failedIds.length + 1) === 0;
    } else {
      const rest = reviewQueue.filter((id) => id !== exercise.id);
      const queue = result.correct ? rest : [...rest, exercise.id];
      willFinish = queue.length === 0 || reviewBudget - 1 <= 0;
    }
  }

  return (
    <div className="session-screen">
      <div className="session-top">
        <button className="icon-btn" onClick={onExit} aria-label={t("session.exitMission")}>
          <Icon name="close" size={16} />
        </button>
        {phase === "main" ? (
          total <= MAX_DOTS ? (
            <div className="dots">
              {Array.from({ length: total }, (_, i) => (
                <i key={i} className={i < mainDone ? "on" : i === mainDone ? "cur" : ""} />
              ))}
            </div>
          ) : (
            <div className="session-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={mainDone}>
              <div className="session-progress-bar">
                <i style={{ width: `${(mainDone / total) * 100}%` }} />
              </div>
              <span className="session-progress-label">{t("session.progress", { done: Math.min(mainDone + 1, total), total })}</span>
            </div>
          )
        ) : (
          <div className="review-badge">
            <Icon name="target" size={14} /> {t("session.reviewLeft", { count: reviewQueue.length })}
          </div>
        )}
      </div>

      <div className="q-card">
        <div className="qk">{qk}</div>
        <ExerciseFigure svg={exercise.figure} />
        <div className="q-eq">
          {render.type === "fill_in_blank" ? (
            <FillBlanks key={exercise.id} stem={exercise.stem} render={render} onChange={setAnswer} result={result} />
          ) : (
            <MathText text={exercise.stem} />
          )}
        </div>
      </div>

      {render.type !== "fill_in_blank" && (
        <ExerciseInput key={exercise.id} render={render} answer={answer} onChange={setAnswer} result={result} />
      )}

      {/* Al fallar: la respuesta buena y el PORQUÉ (teoría + cómo se resuelve), no solo un "casi". */}
      {showExplain && result && (
        <div className="explain-card">
          {correctText && (
            <div className="explain-answer">
              <span className="explain-label">{t("session.correctAnswer")}</span>
              <MathText text={correctText} />
            </div>
          )}
          {result.theory && (
            <div className="explain-block theory">
              <span className="explain-label">
                <Icon name="book" size={13} /> {t("session.theory")}
              </span>
              <MathText text={result.theory} />
            </div>
          )}
          {result.solution && (
            <div className="explain-block">
              <span className="explain-label">{t("session.howTo")}</span>
              <MathText text={result.solution} />
            </div>
          )}
        </div>
      )}

      {!result && hints.length > 0 && (
        <div className="hints">
          {hints.slice(0, hintsShown).map((h, i) => (
            <div className="hint" key={i}>
              <Icon name="star" size={13} /> <MathText text={h} />
            </div>
          ))}
          {hintsShown < hints.length && (
            <button className="btn-ghost sm hint-btn" type="button" onClick={() => setHintsShown((n) => n + 1)}>
              <Icon name="eye" size={14} /> {t("session.hint")}
            </button>
          )}
        </div>
      )}

      <div className="ex-foot">
        <Mascot className="foot-orbi" />
        {result ? (
          <div className={`bubble ${result.correct ? "good" : "bad"}`}>
            <b>
              {result.correct ? (
                <>
                  +{result.coinsAwarded} <Icon name="coin" size={14} />
                </>
              ) : (
                t("session.oops")
              )}
            </b>{" "}
            {result.feedback ?? (result.correct ? t("session.correct") : t("session.almost"))}
            {result.correct && result.solution && <div className="solution-line">{result.solution}</div>}
          </div>
        ) : (
          <div className="bubble">
            <b>{t(`mascot.names.${mascot}`)}:</b> {t("session.youCan")} <Icon name="rocket" size={16} />
          </div>
        )}
      </div>

      {!result ? (
        <>
          {submitError && <p className="session-inline-error">{t("session.sendFailed")}</p>}
          <button className="btn-primary session-next" disabled={!answer || submitting} onClick={submit}>
            {submitting ? t("session.checking") : submitError ? t("session.connRetry") : t("session.check")}
          </button>
        </>
      ) : (
        <button className="btn-primary session-next" onClick={advance}>
          {willFinish ? (
            t("session.finishMission")
          ) : phase === "review" ? (
            <>
              {t("session.retry")} <Icon name="play" size={16} />
            </>
          ) : (
            <>
              {t("session.next")} <Icon name="play" size={16} />
            </>
          )}
        </button>
      )}
      {result && <ReportQuestion key={exercise.id} profileId={profileId} templateId={exercise.id} />}
    </div>
  );
}

// «¿Esta pregunta está mal?»: tras responder (ya ve la solución), el niño puede avisar a su tutor.
// El contenido lo genera una IA: así los errores que se cuelen salen a la luz en vez de frustrarle.
function ReportQuestion({ profileId, templateId }: { profileId: string; templateId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "open" | "sending" | "sent" | "error">("idle");

  async function send(reason: ReportReason) {
    setState("sending");
    try {
      await api.reportExercise({ profileId, exerciseTemplateId: templateId, reason });
      setState("sent");
    } catch {
      setState("error");
    }
  }

  if (state === "sent")
    return (
      <p className="report-q done">
        <Icon name="check" size={13} /> {t("session.reportThanks")}
      </p>
    );
  if (state === "idle")
    return (
      <button type="button" className="report-q link" onClick={() => setState("open")}>
        <Icon name="flag" size={13} /> {t("session.reportAsk")}
      </button>
    );
  return (
    <div className="report-q open">
      <span className="report-q-title">{t("session.reportWhy")}</span>
      <div className="report-q-reasons">
        {REPORT_REASONS.map((r) => (
          <button key={r} type="button" className="btn-ghost sm" disabled={state === "sending"} onClick={() => send(r)}>
            {t(`session.reason_${r}`)}
          </button>
        ))}
        <button type="button" className="btn-ghost sm" disabled={state === "sending"} onClick={() => setState("idle")}>
          {t("common.cancel")}
        </button>
      </div>
      {state === "error" && <p className="session-inline-error">{t("session.reportFailed")}</p>}
    </div>
  );
}
