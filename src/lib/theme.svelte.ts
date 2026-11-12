// The theme the page is drawn in: the computer's (light or dark, following it as it changes), or
// always one. Settings keeps the choice (settings.rs); the page takes it as `data-theme` on <html>,
// which the colour tokens in +layout.svelte read. The choice is also kept in this webview's storage,
// so app.html can put it on <html> before the first paint, without a flash of the other one.
import { THEMES, type Theme } from './api';

const KEY = 'theme';

function remembered(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return THEMES.includes(t as Theme) ? (t as Theme) : 'system';
  } catch {
    return 'system';
  }
}

class ThemeState {
  /** What's chosen; read by what paints with colours it can't take from CSS (charts). */
  choice = $state<Theme>(remembered());

  apply(t: Theme) {
    this.choice = t;
    const root = document.documentElement;
    if (t === 'system') delete root.dataset.theme;
    else root.dataset.theme = t;
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // Not kept for the first paint; Settings still has it.
    }
  }
}

export const theme = new ThemeState();
