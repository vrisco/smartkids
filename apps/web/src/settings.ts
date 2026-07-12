// Ajustes de usuario: tema (sistema/claro/oscuro) e idioma (es/en), persistidos en localStorage.
import i18n, { type Lang } from "./i18n";

export type Theme = "system" | "light" | "dark";
const THEME_KEY = "sk_theme";
const LANG_KEY = "sk_lang";

export function getTheme(): Theme {
  const t = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
  return t === "light" || t === "dark" ? t : "system";
}

/** Aplica el tema al <html>: 'system' quita data-theme (manda prefers-color-scheme). */
export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

export function setTheme(t: Theme): void {
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
}

export function getLang(): Lang {
  return (i18n.language as Lang) === "en" ? "en" : "es";
}

export function setLang(l: Lang): void {
  localStorage.setItem(LANG_KEY, l);
  void i18n.changeLanguage(l);
  document.documentElement.lang = l;
}
