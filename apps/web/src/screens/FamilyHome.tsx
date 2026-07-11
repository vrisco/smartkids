import { useState } from "react";
import { api, type Child, type Me } from "../api";

const AVATARS = ["🦊", "🐼", "🐙", "🦄", "🐸", "🐯", "🤖", "🚀"];

function avatarOf(a: string): string {
  return a && a.length <= 2 ? a : "🚀";
}

export function FamilyHome({
  me,
  onPlay,
  onParent,
  onLogout,
  onRefresh,
}: {
  me: Me;
  onPlay: (child: Child) => void;
  onParent: (child: Child) => void;
  onLogout: () => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState<Child | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function unlock() {
    if (!selected) return;
    setError(null);
    try {
      const r = await api.unlock(selected.id, pin);
      onPlay(r.profile);
    } catch {
      setError("PIN incorrecto");
      setPin("");
    }
  }

  return (
    <div className="family-screen">
      <header className="family-top">
        <div>
          <div className="family-kicker">Familia</div>
          <b>{me.parent.email}</b>
        </div>
        <button className="btn-ghost sm" type="button" onClick={onLogout}>
          Salir
        </button>
      </header>

      {!selected && (
        <>
          <h2 className="family-heading">¿Quién juega?</h2>
          <div className="kids-grid">
            {me.children.map((ch) => (
              <button
                className="kid-card"
                key={ch.id}
                type="button"
                onClick={() => {
                  setSelected(ch);
                  setPin("");
                  setError(null);
                }}
              >
                <span className="kid-avatar">{avatarOf(ch.avatar)}</span>
                <b>{ch.displayName}</b>
                <span className="kid-grade">{ch.gradeBand}</span>
              </button>
            ))}
            <button className="kid-card add" type="button" onClick={() => setAdding(true)}>
              <span className="kid-avatar">＋</span>
              <b>Añadir</b>
            </button>
          </div>
          {me.children.length > 0 && (
            <button className="btn-ghost family-parent" type="button" onClick={() => onParent(me.children[0]!)}>
              👪 Panel de familia
            </button>
          )}
        </>
      )}

      {selected && (
        <div className="pin-panel">
          <button className="link-back" type="button" onClick={() => setSelected(null)}>
            ‹ Volver
          </button>
          <span className="kid-avatar big">{avatarOf(selected.avatar)}</span>
          <b className="pin-name">{selected.displayName}</b>
          <p className="muted">Introduce tu PIN</p>
          <input
            className="field pin-field"
            inputMode="numeric"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void unlock();
            }}
            autoFocus
          />
          {error && <div className="auth-error">{error}</div>}
          <button className="btn-primary" type="button" onClick={unlock} disabled={pin.length < 4}>
            Entrar
          </button>
        </div>
      )}

      {adding && (
        <AddChild
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

function AddChild({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(AVATARS[0]!);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.createChild({ displayName: name, avatar, gradeBand: "ESO-5", pin });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Añadir hijo/a</h3>
        <input className="field" placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="avatar-pick">
          {AVATARS.map((a) => (
            <button
              key={a}
              type="button"
              className={"ava" + (a === avatar ? " on" : "")}
              onClick={() => setAvatar(a)}
            >
              {a}
            </button>
          ))}
        </div>
        <input
          className="field"
          inputMode="numeric"
          maxLength={8}
          placeholder="PIN (4+ dígitos)"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        />
        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" type="button" onClick={create} disabled={busy || !name || pin.length < 4}>
            Crear
          </button>
        </div>
      </div>
    </div>
  );
}
