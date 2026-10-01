import { useTranslation } from "react-i18next";
import { isGradeBand } from "../grades";
import { Icon } from "./Icon";
import { MascotAvatar } from "./Mascot";

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
  return (
    <header className="hud">
      <button className="avatar avatar-btn" onClick={onExit} title={t("hud.switchProfile")} type="button">
        <MascotAvatar size={34} />
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
