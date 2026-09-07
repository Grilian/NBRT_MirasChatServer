export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'themePreference';

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function applyThemePreference(pref: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, pref);
  if (pref === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', pref);
  }
}
