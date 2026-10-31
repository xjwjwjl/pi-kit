export function authorizationHeader(token: string | undefined): string {
  if (!token || token.trim().length === 0) throw new Error("AUTH_TOKEN is required");
  const trimmed = token.trim();
  if (/\s/.test(trimmed)) throw new Error("AUTH_TOKEN must not contain whitespace");
  return `Bearer ${trimmed}`;
}
