import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/app.css";
import "./styles/auth.css";
import { App } from "./App";
import { applyTheme, getTheme } from "./settings";

// Aplica el tema guardado antes del primer render (evita parpadeo).
applyTheme(getTheme());
document.documentElement.lang = localStorage.getItem("sk_lang") === "en" ? "en" : "es";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("No se encontró #root");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
