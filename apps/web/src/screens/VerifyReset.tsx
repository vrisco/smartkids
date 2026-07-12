import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { Orbi } from "../components/Orbi";
import { Icon } from "../components/Icon";

function goHome() {
  window.location.href = "/";
}

export function VerifyPage({ token }: { token: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    if (!token) {
      setState("error");
      return;
    }
    api
      .verifyEmail(token)
      .then(() => setState("ok"))
      .catch(() => setState("error"));
  }, [token]);

  return (
    <div className="auth-screen">
      <Orbi className="auth-orbi" />
      <h1 className="auth-title">Órbita</h1>
      {state === "loading" && <p className="auth-sub">{t("verify.verifying")}</p>}
      {state === "ok" && (
        <p className="auth-sub">
          <Icon name="check" size={18} /> {t("verify.verified")}
        </p>
      )}
      {state === "error" && <p className="auth-error">{t("verify.invalidLink")}</p>}
      <button className="btn-primary" type="button" onClick={goHome}>
        {t("verify.goApp")}
      </button>
    </div>
  );
}

export function ResetPage({ token }: { token: string }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.reset(token, password);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <Orbi className="auth-orbi" />
      <h1 className="auth-title">Órbita</h1>
      {done ? (
        <>
          <p className="auth-sub">
            <Icon name="check" size={18} /> {t("verify.pwChanged")}
          </p>
          <button className="btn-primary" type="button" onClick={goHome}>
            {t("verify.goApp")}
          </button>
        </>
      ) : (
        <>
          <p className="auth-sub">{t("verify.chooseNewPw")}</p>
          <div className="auth-form">
            <input
              className="field"
              type="password"
              placeholder={t("verify.newPwPh")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            {error && <div className="auth-error">{error}</div>}
            <button className="btn-primary" type="button" onClick={submit} disabled={busy || password.length < 6}>
              {busy ? "…" : t("verify.changePw")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
