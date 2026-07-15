// Thin localStorage wrapper: private/incognito modes (notably Safari) throw
// on setItem (quota 0) and some embedders throw on any access at all — every
// call site must degrade to "not persisted" rather than crash the app.

export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns whether the write succeeded. */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
