import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { loginWithPasskey, passkeySupported } from "../passkeys";
import { Orbi } from "./Orbi";
import { Icon } from "./Icon";
import { SettingsToggle } from "./SettingsToggle";

type Mode = "tutor" | "child" | "forgot";

export function Auth({ onTutor, onChild }: { onTutor: () => void; onChild: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("tutor");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setError(null);
    setInfo(null);
    setDevLink(null);
  }

  async function passkeyLogin() {
    setBusy(true);
    reset();
    try {
      await loginWithPasskey();
      onTutor();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    reset();
    try {
      if (mode === "tutor") {
        await api.login(email, password);
        onTutor();
      } else if (mode === "child") {
        await api.childLogin(username, pin);
        onChild();
      } else {
        const r = await api.forgot(email);
        setInfo(t("auth.forgotSent"));
        if (r.devLink) setDevLink(r.devLink);
        setBusy(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-top-bar">
        <SettingsToggle />
      </div>
      <Orbi className="auth-orbi float" />
      <h1 className="auth-title">Órbita</h1>

      {mode !== "forgot" && (
        <div className="auth-tabs">
          <button className={mode === "tutor" ? "on" : ""} type="button" onClick={() => { setMode("tutor"); reset(); }}>
            {t("auth.tutorTab")}
          </button>
          <button className={mode === "child" ? "on" : ""} type="button" onClick={() => { setMode("child"); reset(); }}>
            {t("auth.kidTab")}
          </button>
        </div>
      )}

      <form className="auth-form" onSubmit={submit}>
        {mode === "tutor" && (
          <>
            <input className="field" type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            <input className="field" type="password" placeholder={t("auth.password")} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </>
        )}
        {mode === "child" && (
          <>
            <input className="field" placeholder={t("auth.yourUsername")} value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} autoCapitalize="none" required />
            <input className="field" inputMode="numeric" maxLength={8} placeholder={t("auth.yourPin")} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} required />
          </>
        )}
        {mode === "forgot" && (
          <input className="field" type="email" placeholder={t("auth.yourEmail")} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        )}

        {error && <div className="auth-error">{error}</div>}
        {info && <div className="auth-info">{info}</div>}
        {devLink && (
          <a className="auth-devlink" href={devLink}>
            {t("auth.devLink")} <Icon name="arrow" size={14} />
          </a>
        )}

        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "…" : mode === "tutor" ? t("auth.enter") : mode === "child" ? t("auth.play") : t("auth.sendLink")}
        </button>
      </form>

      {mode === "tutor" && passkeySupported() && (
        <button className="btn-ghost auth-passkey" type="button" disabled={busy} onClick={passkeyLogin}>
          <Icon name="lock" size={16} /> {t("auth.passkey")}
        </button>
      )}

      {mode === "tutor" && (
        <button className="auth-toggle" type="button" onClick={() => { setMode("forgot"); reset(); }}>
          {t("auth.forgot")}
        </button>
      )}
      {mode === "forgot" && (
        <button className="auth-toggle" type="button" onClick={() => { setMode("tutor"); reset(); }}>
          <Icon name="back" size={14} /> {t("common.back")}
        </button>
      )}

      {mode === "child" && <p className="auth-demo">{t("auth.demoKidLabel")} <b>lucia</b> / PIN <b>1234</b></p>}

      <div className="app-version">v{__APP_VERSION__}</div>
    </div>
  );
}
