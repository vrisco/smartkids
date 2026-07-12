import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

export function Hud({
  profile,
  balance,
  onExit,
}: {
  profile: { displayName: string; gradeBand: string };
  balance: number;
  onExit?: () => void;
}) {
  const { t } = useTranslation();
  const initial = profile.displayName.charAt(0).toUpperCase();
  return (
    <header className="hud">
      <button className="avatar avatar-btn" onClick={onExit} title={t("hud.switchProfile")} type="button">
        {initial}
      </button>
      <div className="who">
        <b>{profile.displayName}</b>
        <span>{profile.gradeBand}</span>
      </div>
      <span className="stat flame">
        <Icon name="flame" size={14} /> 7
      </span>
      <span className="stat coin">
        <Icon name="coin" size={14} /> {balance}
      </span>
    </header>
  );
}
