import { useEffect, useState } from "react";
import { api } from "../api";
import { Orbi } from "../components/Orbi";

function goHome() {
  window.location.href = "/";
}

export function VerifyPage({ token }: { token: string }) {
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
      {state === "loading" && <p className="auth-sub">Verificando tu email…</p>}
      {state === "ok" && <p className="auth-sub">✅ ¡Email verificado! Ya puedes entrar.</p>}
      {state === "error" && <p className="auth-error">El enlace es inválido o ha caducado.</p>}
      <button className="btn-primary" type="button" onClick={goHome}>
        Ir a la app
      </button>
    </div>
  );
}

export function ResetPage({ token }: { token: string }) {
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
          <p className="auth-sub">✅ Contraseña cambiada. Ya puedes entrar con la nueva.</p>
          <button className="btn-primary" type="button" onClick={goHome}>
            Ir a la app
          </button>
        </>
      ) : (
        <>
          <p className="auth-sub">Elige una nueva contraseña</p>
          <div className="auth-form">
            <input
              className="field"
              type="password"
              placeholder="Nueva contraseña (6+)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            {error && <div className="auth-error">{error}</div>}
            <button className="btn-primary" type="button" onClick={submit} disabled={busy || password.length < 6}>
              {busy ? "…" : "Cambiar contraseña"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
