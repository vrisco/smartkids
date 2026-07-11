import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Orbi } from "./Orbi";

type Mode = "tutor" | "child" | "forgot";

export function Auth({ onTutor, onChild }: { onTutor: () => void; onChild: () => void }) {
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
        setInfo("Si el email existe, te hemos enviado un enlace para restablecer la contraseña.");
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
      <Orbi className="auth-orbi float" />
      <h1 className="auth-title">Órbita</h1>

      {mode !== "forgot" && (
        <div className="auth-tabs">
          <button className={mode === "tutor" ? "on" : ""} type="button" onClick={() => { setMode("tutor"); reset(); }}>
            Tutor / Profe
          </button>
          <button className={mode === "child" ? "on" : ""} type="button" onClick={() => { setMode("child"); reset(); }}>
            Niño
          </button>
        </div>
      )}

      <form className="auth-form" onSubmit={submit}>
        {mode === "tutor" && (
          <>
            <input className="field" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            <input className="field" type="password" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </>
        )}
        {mode === "child" && (
          <>
            <input className="field" placeholder="Tu usuario" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} autoCapitalize="none" required />
            <input className="field" inputMode="numeric" maxLength={8} placeholder="Tu PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} required />
          </>
        )}
        {mode === "forgot" && (
          <input className="field" type="email" placeholder="Tu email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        )}

        {error && <div className="auth-error">{error}</div>}
        {info && <div className="auth-info">{info}</div>}
        {devLink && (
          <a className="auth-devlink" href={devLink}>
            Enlace de prueba (dev) →
          </a>
        )}

        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "…" : mode === "tutor" ? "Entrar" : mode === "child" ? "¡A jugar!" : "Enviar enlace"}
        </button>
      </form>

      {mode === "tutor" && (
        <button className="auth-toggle" type="button" onClick={() => { setMode("forgot"); reset(); }}>
          ¿Olvidaste tu contraseña?
        </button>
      )}
      {mode === "forgot" && (
        <button className="auth-toggle" type="button" onClick={() => { setMode("tutor"); reset(); }}>
          ‹ Volver
        </button>
      )}

      {mode === "tutor" && <p className="auth-demo">Demo tutor: <b>demo@smartkids.dev</b> / <b>demo1234</b></p>}
      {mode === "child" && <p className="auth-demo">Demo niño: usuario <b>lucia</b> / PIN <b>1234</b></p>}
    </div>
  );
}
