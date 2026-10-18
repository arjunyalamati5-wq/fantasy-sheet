// Theme: the light "studio" sheet is the app's own default, whatever the OS
// says; dark (prime time) is one click away and, once chosen, sticks.

const KEY = 'ff.theme';

export function currentTheme() {
  try {
    if (localStorage.getItem(KEY) === 'dark') return 'dark';
  } catch { /* private browsing */ }
  return 'light';
}

/** What the page is actually showing right now. */
export function resolvedTheme() {
  return currentTheme();
}

export function setTheme(theme) {
  try {
    if (theme === 'dark') localStorage.setItem(KEY, 'dark');
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

export function nextTheme() {
  return currentTheme() === 'dark' ? 'light' : 'dark';
}

export function themeLabel() {
  return currentTheme() === 'dark' ? 'Dark' : 'Light';
}
