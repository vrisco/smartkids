import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type Answer, type AttemptResult, type Exercise } from "../api";
import { ExerciseInput, FillBlanks, correctAnswerString } from "../components/ExerciseInput";
import { ExerciseFigure } from "../components/ExerciseFigure";
import { Icon } from "../components/Icon";
import { MathText } from "../components/MathText";
import { Orbi } from "../components/Orbi";
import { keepAwake, vibrate } from "../pwa";

const QUESTIONS_PER_SESSION = 5;
const REVIEW_EXTRA = 3; // margen de reintentos sobre el nº de fallos, para no frustrar

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
  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [phase, setPhase] = useState<"main" | "review">("main");
  const [mainDone, setMainDone] = useState(0);
  const [wrong, setWrong] = useState(0);
  const [reviewLeft, setReviewLeft] = useState(0);
  const [reviewBudget, setReviewBudget] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [error, setError] = useState(false);
  const served = useRef<string[]>([]);

  const load = useCallback(() => {
    setAnswer(null);
    setResult(null);
    setExercise(null);
    api
      .nextExercise(skillId, profileId, served.current)
      .then((ex) => {
        setExercise(ex);
        setStartedAt(Date.now());
      })
      .catch(() => setError(true));
  }, [skillId, profileId]);

  useEffect(() => {
    load();
  }, [load]);

  // Mantén la pantalla encendida mientras dura la sesión (se libera al salir).
  useEffect(() => keepAwake(), []);

  async function submit() {
    if (!exercise || !answer || result) return;
    try {
      const res = await api.attempt({ profileId, exerciseTemplateId: exercise.id, answer, responseTimeMs: Date.now() - startedAt });
      onBalance(res.balance);
      served.current = [...served.current, exercise.id];
      setResult(res);
      vibrate(res.correct ? 30 : [40, 60, 40]); // háptico: acierto corto, fallo doble
    } catch {
      setError(true);
    }
  }

  function advance() {
    if (!result) return;
    const ok = result.correct;
    if (phase === "main") {
      const nd = mainDone + 1;
      const totalWrong = wrong + (ok ? 0 : 1);
      setMainDone(nd);
      setWrong(totalWrong);
      if (nd >= QUESTIONS_PER_SESSION) {
        if (totalWrong > 0) {
          setPhase("review");
          setReviewLeft(totalWrong);
          setReviewBudget(totalWrong + REVIEW_EXTRA);
          load();
        } else {
          onExit();
        }
        return;
      }
      load();
    } else {
      const nl = reviewLeft - (ok ? 1 : 0);
      const nb = reviewBudget - 1;
      if (nl <= 0 || nb <= 0) {
        onExit();
        return;
      }
      setReviewLeft(nl);
      setReviewBudget(nb);
      load();
    }
  }

  if (error) return <p className="screen-pad muted">{t("session.connError")}</p>;
  if (!exercise) return <p className="screen-pad muted">{t("session.loadingMission")}</p>;

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
            : t("session.solve");

  const showCorrectText =
    Boolean(result && !result.correct && result.correctAnswer) &&
    render.type !== "multiple_choice" &&
    render.type !== "true_false";

  const willFinish = Boolean(
    result &&
      ((phase === "main" && mainDone + 1 >= QUESTIONS_PER_SESSION && wrong + (result.correct ? 0 : 1) === 0) ||
        (phase === "review" && (reviewLeft - (result.correct ? 1 : 0) <= 0 || reviewBudget - 1 <= 0))),
  );

  return (
    <div className="session-screen">
      <div className="session-top">
        <button className="icon-btn" onClick={onExit} aria-label={t("session.exitMission")}>
          <Icon name="close" size={16} />
        </button>
        {phase === "main" ? (
          <div className="dots">
            {Array.from({ length: QUESTIONS_PER_SESSION }, (_, i) => (
              <i key={i} className={i < mainDone ? "on" : i === mainDone ? "cur" : ""} />
            ))}
          </div>
        ) : (
          <div className="review-badge">
            <Icon name="target" size={14} /> {t("session.reviewLeft", { count: reviewLeft })}
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

      <div className="ex-foot">
        <Orbi className="foot-orbi" />
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
            {showCorrectText && result.correctAnswer && (
              <div className="correct-line">
                {t("session.correctAnswer")}: <MathText text={correctAnswerString(render, result.correctAnswer)} />
              </div>
            )}
            {result.solution && <div className="solution-line">{result.solution}</div>}
          </div>
        ) : (
          <div className="bubble">
            <b>{t("session.orbi")}</b> {t("session.youCan")} <Icon name="rocket" size={16} />
          </div>
        )}
      </div>

      {!result ? (
        <button className="btn-primary session-next" disabled={!answer} onClick={submit}>
          {t("session.check")}
        </button>
      ) : (
        <button className="btn-primary session-next" onClick={advance}>
          {willFinish ? (
            t("session.finishMission")
          ) : (
            <>
              {t("session.next")} <Icon name="play" size={16} />
            </>
          )}
        </button>
      )}
    </div>
  );
}
