/** `url`'s path and query with one parameter set (or, for null, removed). */
export function withParam(url: URL, key: string, value: string | null): string {
  const params = new URLSearchParams(url.search);
  if (value == null) params.delete(key);
  else params.set(key, value);
  const query = params.toString();
  return url.pathname + (query ? `?${query}` : '');
}

export type Section = 'vms' | 'containers' | 'images' | 'volumes' | 'settings';
const OTHERS: Section[] = ['containers', 'images', 'volumes', 'settings'];

/**
 * The masthead section `pathname` is in. Everything else is VMs: `/`, `/vm/…`, and the path the
 * app starts at, which is empty (Tauri loads `tauri://localhost`, and a URL of a scheme the URL
 * standard doesn't know has no `/` path of its own).
 */
export function section(pathname: string): Section {
  return OTHERS.find((s) => pathname === `/${s}` || pathname.startsWith(`/${s}/`)) ?? 'vms';
}
