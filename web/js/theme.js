// Light, dark or follow the system. Stored per browser.

export function currentTheme() {
  try { return localStorage.getItem("theme") || "system"; } catch { return "system"; }
}

export function applyTheme(theme = currentTheme()) {
  try { localStorage.setItem("theme", theme); } catch {}
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#000000" : "#f5f5f7");
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
