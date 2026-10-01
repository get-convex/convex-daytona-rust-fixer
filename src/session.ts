/**
 * An anonymous id for this browser, used for per-session rate limits and to
 * show you only your own runs. Easy to spoof, which is why the server also
 * has global limits.
 */
const KEY = "rust-fixer-session";

export function getSessionId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID(); // private mode: a fresh session per tab
  }
}
