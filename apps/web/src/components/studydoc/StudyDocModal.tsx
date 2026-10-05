// El tutor abre un documento de estudio: lo ve como en la app (con todas las soluciones) y lo imprime.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type TutorStudyDoc } from "../../api";
import { Icon } from "../Icon";
import { usePrintJob, type PaperSize } from "../print/PrintShell";
import { fontPtFor, profileFor, type FontChoice } from "../print/profiles";
import { KIND_ICON } from "./kinds";
import { StudyDocView } from "./StudyDocView";

export function StudyDocModal({ docId, onClose, autoPrint }: { docId: string; onClose: () => void; autoPrint?: boolean }) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<TutorStudyDoc | null>(null);
  const [error, setError] = useState(false);
  const [paper, setPaper] = useState<PaperSize>("A4");
  const [font, setFont] = useState<FontChoice>("auto");
  const [cards, setCards] = useState<"duplex" | "fold">("duplex");
  const [showPrint, setShowPrint] = useState(Boolean(autoPrint));
  const { print, portal } = usePrintJob();

  useEffect(() => {
    api
      .tutorStudyDoc(docId)
      .then(setDoc)
      .catch(() => setError(true));
  }, [docId]);

  const profile = doc ? profileFor(doc.subjectId, doc.gradeBand) : null;

  function doPrint() {
    if (!doc || !profile) return;
    print(<StudyDocView doc={doc.body} medium="paper" profile={profile} fontPt={fontPtFor(profile, font)} cardsLayout={cards} kicker={doc.body.subtitle} />, {
      fileName: `${doc.title} - ${t(`studydoc.kind_${doc.kind}`)}`,
      paper,
      landscape: doc.body.print?.orientation === "landscape",
      headerText: doc.title,
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal studydoc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <div className="list-main">
            <b>
              {doc && <Icon name={KIND_ICON[doc.kind]} size={16} />} {doc ? t(`studydoc.kind_${doc.kind}`) : t("studydoc.loading")}
            </b>
            {doc && <span className="muted">{doc.title}</span>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {error ? (
          <p className="muted screen-pad">{t("studydoc.loadError")}</p>
        ) : !doc || !profile ? (
          <p className="muted screen-pad">{t("studydoc.loading")}</p>
        ) : (
          <>
            {showPrint ? (
              <div className="print-bar">
                <label className="form-cell">
                  <span className="course-label">{t("print.paper")}</span>
                  <select className="field" value={paper} onChange={(e) => setPaper(e.target.value as PaperSize)}>
                    <option value="A4">{t("print.paper_a4")}</option>
                    <option value="letter">{t("print.paper_letter")}</option>
                  </select>
                </label>
                <label className="form-cell">
                  <span className="course-label">{t("print.fontSize")}</span>
                  <select className="field" value={font} onChange={(e) => setFont(e.target.value as FontChoice)}>
                    {(["auto", "normal", "large", "xlarge"] as const).map((f) => (
                      <option key={f} value={f}>
                        {t(`print.font_${f}`)}
                      </option>
                    ))}
                  </select>
                </label>
                {doc.kind === "flashcards" && (
                  <label className="form-cell">
                    <span className="course-label">{t("print.cardsLayout")}</span>
                    <select className="field" value={cards} onChange={(e) => setCards(e.target.value as "duplex" | "fold")}>
                      <option value="duplex">{t("print.duplex")}</option>
                      <option value="fold">{t("print.fold")}</option>
                    </select>
                  </label>
                )}
                <p className="reward-hint">{doc.kind === "flashcards" && cards === "duplex" ? t("print.duplexTip") : t("print.browserTip")}</p>
                <div className="modal-actions">
                  <button className="btn-ghost" type="button" onClick={() => setShowPrint(false)}>
                    {t("common.cancel")}
                  </button>
                  <button className="btn-primary" type="button" onClick={doPrint}>
                    <Icon name="printer" size={16} /> {t("print.print")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="modal-actions top">
                <button className="btn-primary" type="button" onClick={() => setShowPrint(true)}>
                  <Icon name="printer" size={16} /> {t("print.printDots")}
                </button>
              </div>
            )}
            <div className="studydoc-scroll">
              <StudyDocView doc={doc.body} medium="screen" profile={profile} reveal />
            </div>
          </>
        )}
      </div>
      {portal}
    </div>
  );
}
