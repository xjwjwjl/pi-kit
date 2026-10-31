// Builds the HTTP Authorization header for the supplied token.
export function authorizationHeader(token: string | undefined): string {
  if (!token || token.trim().length === 0) throw new Error("AUTH_TOKEN is required");
  return `Bearer ${token.trim()}`;
}
