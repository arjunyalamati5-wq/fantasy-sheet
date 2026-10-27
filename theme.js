// Theme: the dark olive "lime" sheet is the app's own default, whatever the OS
// says; light (paper) is one click away and, once chosen, sticks.

const KEY = 'ff.theme';

export function currentTheme() {
  try {
    if (localStorage.getItem(KEY) === 'light') return 'light';
  } catch { /* private browsing */ }
  return 'dark';
}

/** What the page is actually showing right now. */
export function resolvedTheme() {
  return currentTheme();
}

export function setTheme(theme) {
  try {
    if (theme === 'light') localStorage.setItem(KEY, 'light');
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

export function nextTheme() {
  return currentTheme() === 'dark' ? 'light' : 'dark';
}

export function themeLabel() {
  return currentTheme() === 'dark' ? 'Dark' : 'Light';
}
