import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// i18n de la UI. El CONTENIDO de los ejercicios es multi-idioma en la BD (no aquí).
const resources = {
  es: {
    translation: {
      tagline: "Aprende explorando la galaxia",
      start: "Empezar misión",
      apiStatus: "Backend",
    },
  },
  en: {
    translation: {
      tagline: "Learn by exploring the galaxy",
      start: "Start mission",
      apiStatus: "Backend",
    },
  },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: "es",
  fallbackLng: "es",
  interpolation: { escapeValue: false },
});

export default i18n;
