import { useEffect, useState } from "react";
import { api, tx, type Child, type Course, type Me } from "../api";

const AVATARS = ["🦊", "🐼", "🐙", "🦄", "🐸", "🐯", "🤖", "🚀"];
const avatarOf = (a: string) => (a && a.length <= 2 ? a : "🚀");

export function TutorPanel({ me, onLogout, onRefresh }: { me: Me; onLogout: () => void; onRefresh: () => void }) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [editing, setEditing] = useState<Child | null>(null);
  const [creating, setCreating] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

  useEffect(() => {
    api.courses().then(setCourses).catch(() => {});
  }, []);

  async function resendVerify() {
    try {
      const r = await api.resendVerification();
      setVerifyMsg(r.devLink ? "Enlace de verificación (dev) generado." : "Email de verificación reenviado.");
    } catch {
      setVerifyMsg("No se pudo reenviar.");
    }
  }

  return (
    <div className="app-shell">
      <header className="panel-top">
        <div>
          <div className="panel-kicker">Tutor</div>
          <b>{me.parent.email}</b>
        </div>
        <button className="btn-ghost sm" type="button" onClick={onLogout}>
          Salir
        </button>
      </header>
      <div className="app-body">
        {!me.parent.emailVerified && (
          <div className="verify-banner">
            <span>✉️ Verifica tu email.</span>
            <button className="btn-ghost sm" type="button" onClick={resendVerify}>
              Reenviar
            </button>
          </div>
        )}
        {verifyMsg && <div className="auth-info panel-msg">{verifyMsg}</div>}

        <div className="panel-head">
          <h2 className="screen-title">Mis niños</h2>
          <button className="btn-primary sm" type="button" onClick={() => setCreating(true)}>
            ＋ Nuevo
          </button>
        </div>
        <div className="list">
          {me.children.map((ch) => (
            <div className="list-row" key={ch.id}>
              <span className="kid-avatar sm">{avatarOf(ch.avatar)}</span>
              <div className="list-main">
                <b>{ch.displayName}</b>
                <span>@{ch.username}</span>
              </div>
              <button className="btn-ghost sm" type="button" onClick={() => setEditing(ch)}>
                Editar
              </button>
            </div>
          ))}
          {me.children.length === 0 && <p className="muted screen-pad">Aún no tienes niños. Crea el primero.</p>}
        </div>

        <button className="btn-ghost panel-pw" type="button" onClick={() => setChangingPw(true)}>
          🔒 Cambiar mi contraseña
        </button>
      </div>

      {creating && <ChildForm courses={courses} onClose={() => setCreating(false)} onDone={() => { setCreating(false); onRefresh(); }} />}
      {editing && <ChildForm child={editing} courses={courses} onClose={() => setEditing(null)} onDone={() => { setEditing(null); onRefresh(); }} />}
      {changingPw && <ChangePassword onClose={() => setChangingPw(false)} />}
    </div>
  );
}

function ChildForm({ child, courses, onClose, onDone }: { child?: Child; courses: Course[]; onClose: () => void; onDone: () => void }) {
  const editing = Boolean(child);
  const [name, setName] = useState(child?.displayName ?? "");
  const [username, setUsername] = useState(child?.username ?? "");
  const [pin, setPin] = useState("");
  const [avatar, setAvatar] = useState(child && child.avatar.length <= 2 ? child.avatar : AVATARS[0]!);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (child)
      api
        .childCourses(child.id)
        .then((cs) => setSel(cs.map((c) => c.id)))
        .catch(() => {});
  }, [child]);

  function toggle(id: string) {
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let id = child?.id;
      if (editing) {
        const patch: { displayName: string; avatar: string; username: string; pin?: string } = { displayName: name, avatar, username };
        if (pin.length >= 4) patch.pin = pin;
        await api.updateChild(child!.id, patch);
      } else {
        if (pin.length < 4) throw new Error("El PIN debe tener 4+ dígitos.");
        const r = await api.createChild({ displayName: name, username, avatar, gradeBand: "ESO-5", pin, courseIds: sel });
        id = r.profile.id;
      }
      if (id) await api.setChildCourses(id, sel);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!child) return;
    if (!window.confirm(`¿Eliminar a ${child.displayName}? Se borrará su progreso.`)) return;
    setBusy(true);
    try {
      await api.deleteChild(child.id);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? "Editar niño" : "Nuevo niño"}</h3>
        <input className="field" placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="field"
          placeholder="Usuario (para su login)"
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, "").toLowerCase())}
          autoCapitalize="none"
        />
        <input
          className="field"
          inputMode="numeric"
          maxLength={8}
          placeholder={editing ? "Nuevo PIN (dejar vacío = igual)" : "PIN (4+ dígitos)"}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        />
        <div className="avatar-pick">
          {AVATARS.map((a) => (
            <button key={a} type="button" className={"ava" + (a === avatar ? " on" : "")} onClick={() => setAvatar(a)}>
              {a}
            </button>
          ))}
        </div>
        <div className="course-label">Cursos con acceso:</div>
        <div className="course-checks">
          {courses.map((cr) => (
            <label className={"course-check" + (sel.includes(cr.id) ? " on" : "")} key={cr.id}>
              <input type="checkbox" checked={sel.includes(cr.id)} onChange={() => toggle(cr.id)} />
              {tx(cr.nameI18n)}
            </label>
          ))}
          {courses.length === 0 && <span className="muted">No hay cursos disponibles.</span>}
        </div>
        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          {editing && (
            <button className="btn-danger" type="button" onClick={remove} disabled={busy}>
              Eliminar
            </button>
          )}
          <button className="btn-ghost" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" type="button" onClick={save} disabled={busy || !name || username.length < 3}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(cur, next);
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
        <h3>Cambiar contraseña</h3>
        {done ? (
          <>
            <div className="auth-info">Contraseña cambiada.</div>
            <div className="modal-actions">
              <button className="btn-primary" type="button" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </>
        ) : (
          <>
            <input className="field" type="password" placeholder="Contraseña actual" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
            <input className="field" type="password" placeholder="Nueva contraseña (6+)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" type="button" onClick={onClose}>
                Cancelar
              </button>
              <button className="btn-primary" type="button" onClick={save} disabled={busy || next.length < 6}>
                Guardar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
