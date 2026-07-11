import { useEffect, useState } from "react";
import { api, type Parent, type Tutor } from "../api";

export function AdminPanel({ parent, onLogout }: { parent: Parent; onLogout: () => void }) {
  const [tutors, setTutors] = useState<Tutor[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [resetFor, setResetFor] = useState<Tutor | null>(null);

  function load() {
    api.adminTutors().then(setTutors).catch(() => setTutors([]));
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="app-shell">
      <header className="panel-top">
        <div>
          <div className="panel-kicker">Administrador</div>
          <b>{parent.email}</b>
        </div>
        <button className="btn-ghost sm" type="button" onClick={onLogout}>
          Salir
        </button>
      </header>
      <div className="app-body">
        <div className="panel-head">
          <h2 className="screen-title">Tutores</h2>
          <button className="btn-primary sm" type="button" onClick={() => setShowCreate(true)}>
            ＋ Nuevo tutor
          </button>
        </div>
        <div className="list">
          {(tutors ?? []).map((t) => (
            <div className="list-row" key={t.id}>
              <div className="list-main">
                <b>{t.email}</b>
                <span>{t.emailVerified ? "email verificado" : "sin verificar"}</span>
              </div>
              <button className="btn-ghost sm" type="button" onClick={() => setResetFor(t)}>
                Resetear
              </button>
            </div>
          ))}
          {tutors && tutors.length === 0 && <p className="muted screen-pad">Aún no hay tutores. Crea el primero.</p>}
        </div>
      </div>
      {showCreate && (
        <CreateTutor
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {resetFor && <ResetTutor tutor={resetFor} onClose={() => setResetFor(null)} />}
    </div>
  );
}

function CreateTutor({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.createTutor(email, password);
      onCreated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Nuevo tutor</h3>
        <input className="field" type="email" placeholder="Email del tutor" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="field" type="text" placeholder="Contraseña inicial (6+)" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" type="button" onClick={create} disabled={busy || !email.includes("@") || password.length < 6}>
            Crear tutor
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetTutor({ tutor, onClose }: { tutor: Tutor; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      await api.resetTutorPassword(tutor.id, password);
      setDone(true);
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Resetear contraseña</h3>
        <p className="muted">{tutor.email}</p>
        {done ? (
          <>
            <div className="auth-info">Contraseña actualizada. Comunícasela al tutor.</div>
            <div className="modal-actions">
              <button className="btn-primary" type="button" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </>
        ) : (
          <>
            <input className="field" type="text" placeholder="Nueva contraseña (6+)" value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" type="button" onClick={onClose}>
                Cancelar
              </button>
              <button className="btn-primary" type="button" onClick={reset} disabled={busy || password.length < 6}>
                Resetear
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
