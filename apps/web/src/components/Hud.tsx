import { useTranslation } from "react-i18next";
import { isGradeBand } from "../grades";
import { Icon } from "./Icon";

export function Hud({
  profile,
  balance,
  streak,
  onExit,
}: {
  profile: { displayName: string; gradeBand: string };
  balance: number;
  streak: number;
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
        {isGradeBand(profile.gradeBand) && <span>{t(`grades.${profile.gradeBand}`)}</span>}
      </div>
      <span className="stat flame" title={t("hud.streak", { count: streak })}>
        <Icon name="flame" size={14} /> {streak}
      </span>
      <span className="stat coin">
        <Icon name="coin" size={14} /> {balance}
      </span>
    </header>
  );
}
