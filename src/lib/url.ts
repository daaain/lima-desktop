/** `url`'s path and query with one parameter set (or, for null, removed). */
export function withParam(url: URL, key: string, value: string | null): string {
  const params = new URLSearchParams(url.search);
  if (value == null) params.delete(key);
  else params.set(key, value);
  const query = params.toString();
  return url.pathname + (query ? `?${query}` : '');
}
