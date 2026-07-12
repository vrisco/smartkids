import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type Exercise } from "../api";
import { Icon } from "../components/Icon";
import { MathText } from "../components/MathText";
import { Orbi } from "../components/Orbi";

const QUESTIONS_PER_SESSION = 5;

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
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<{ correct: boolean; coins: number; msg: string } | null>(null);
  const [done, setDone] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setSelected(null);
    setResult(null);
    api
      .nextExercise(skillId, profileId)
      .then((ex) => {
        setExercise(ex);
        setStartedAt(Date.now());
      })
      .catch(() => setError(true));
  }, [skillId, profileId]);

  useEffect(() => {
    load();
  }, [load]);

  async function choose(optId: string) {
    if (!exercise || result) return;
    const opt = exercise.payload.options?.find((o) => o.id === optId);
    if (!opt) return;
    setSelected(optId);
    const correct = Boolean(opt.isCorrect);
    try {
      const res = await api.attempt({
        profileId,
        skillId,
        exerciseTemplateId: exercise.id,
        contentVersion: exercise.contentVersion,
        correct,
        responseTimeMs: Date.now() - startedAt,
      });
      onBalance(res.balance);
      const msg = correct
        ? exercise.payload.feedback?.correct ?? t("session.correct")
        : exercise.payload.feedback?.incorrect ?? t("session.almost");
      setResult({ correct, coins: res.coinsAwarded, msg });
    } catch {
      setError(true);
    }
  }

  function next() {
    const n = done + 1;
    setDone(n);
    if (n >= QUESTIONS_PER_SESSION) {
      onExit();
      return;
    }
    load();
  }

  if (error) return <p className="screen-pad muted">{t("session.connError")}</p>;
  if (!exercise) return <p className="screen-pad muted">{t("session.loadingMission")}</p>;

  const options = exercise.payload.options ?? [];

  return (
    <div className="session-screen">
      <div className="session-top">
        <button className="icon-btn" onClick={onExit} aria-label={t("session.exitMission")}>
          <Icon name="close" size={16} />
        </button>
        <div className="dots">
          {Array.from({ length: QUESTIONS_PER_SESSION }, (_, i) => (
            <i key={i} className={i < done ? "on" : i === done ? "cur" : ""} />
          ))}
        </div>
      </div>

      <div className="q-card">
        <div className="qk">{t("session.solve")}</div>
        <div className="q-eq">
          <MathText text={exercise.stem} />
        </div>
      </div>

      <div className="opts">
        {options.map((o) => {
          let cls = "opt";
          if (result) {
            if (o.isCorrect) cls += " correct";
            else if (o.id === selected) cls += " wrong";
          } else if (o.id === selected) {
            cls += " sel";
          }
          return (
            <button key={o.id} className={cls} disabled={Boolean(result)} onClick={() => choose(o.id)}>
              <MathText text={o.text} />
            </button>
          );
        })}
      </div>

      <div className="ex-foot">
        <Orbi className="foot-orbi" />
        {result ? (
          <div className={`bubble ${result.correct ? "good" : "bad"}`}>
            <b>
              {result.correct ? (
                <>
                  +{result.coins} <Icon name="coin" size={14} />
                </>
              ) : (
                t("session.oops")
              )}
            </b>{" "}
            {result.msg}
          </div>
        ) : (
          <div className="bubble">
            <b>{t("session.orbi")}</b> {t("session.youCan")} <Icon name="rocket" size={16} />
          </div>
        )}
      </div>

      {result && (
        <button className="btn-primary session-next" onClick={next}>
          {done + 1 >= QUESTIONS_PER_SESSION ? (
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
