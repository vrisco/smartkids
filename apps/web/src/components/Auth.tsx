import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Orbi } from "./Orbi";

export function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await api.login(email, password);
      else await api.signup(email, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <Orbi className="auth-orbi float" />
      <h1 className="auth-title">Órbita</h1>
      <p className="auth-sub">
        {mode === "login" ? "Entra a tu cuenta de familia" : "Crea tu cuenta de familia"}
      </p>
      <form className="auth-form" onSubmit={submit}>
        <input
          className="field"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          className="field"
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
        />
        {error && <div className="auth-error">{error}</div>}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Entrar" : "Crear cuenta"}
        </button>
      </form>
      <button
        className="auth-toggle"
        type="button"
        onClick={() => {
          setMode(mode === "login" ? "signup" : "login");
          setError(null);
        }}
      >
        {mode === "login" ? "¿No tienes cuenta? Regístrate" : "¿Ya tienes cuenta? Entra"}
      </button>
      <p className="auth-demo">
        Demo: <b>demo@smartkids.dev</b> / <b>demo1234</b> · PIN <b>1234</b>
      </p>
    </div>
  );
}
