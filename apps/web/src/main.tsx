import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/app.css";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("No se encontró #root");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
