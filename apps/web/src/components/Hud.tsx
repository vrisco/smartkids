export function Hud({
  profile,
  balance,
  onExit,
}: {
  profile: { displayName: string; gradeBand: string };
  balance: number;
  onExit?: () => void;
}) {
  const initial = profile.displayName.charAt(0).toUpperCase();
  return (
    <header className="hud">
      <button className="avatar avatar-btn" onClick={onExit} title="Cambiar de perfil" type="button">
        {initial}
      </button>
      <div className="who">
        <b>{profile.displayName}</b>
        <span>{profile.gradeBand}</span>
      </div>
      <span className="stat flame">🔥 7</span>
      <span className="stat coin">✦ {balance}</span>
    </header>
  );
}
