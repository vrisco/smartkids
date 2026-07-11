import type { Profile } from "../api";

export function Hud({ profile, balance }: { profile: Profile; balance: number }) {
  const initial = profile.displayName.charAt(0).toUpperCase();
  return (
    <header className="hud">
      <div className="avatar">{initial}</div>
      <div className="who">
        <b>{profile.displayName}</b>
        <span>{profile.gradeBand}</span>
      </div>
      <span className="stat flame">🔥 7</span>
      <span className="stat coin">✦ {balance}</span>
    </header>
  );
}
