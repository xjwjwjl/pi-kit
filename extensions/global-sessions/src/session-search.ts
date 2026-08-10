import { normalizeText } from "./session-json.ts";
import type { GlobalSession } from "./types.ts";

export function queryTerms(query: string): string[] {
	return query
		.match(/"[^"]+"|\S+/g)
		?.map((term) => term.replace(/^"|"$/g, "").toLocaleLowerCase())
		.filter(Boolean) ?? [];
}

export function sessionTitle(session: GlobalSession): string {
	return session.name || session.firstPrompt || "(untitled session)";
}

export function projectLabel(cwd: string): string {
	const normalized = cwd.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).at(-1) || cwd || "(unknown project)";
}

export function matchesSession(session: GlobalSession, query: string): boolean {
	const terms = queryTerms(query);
	if (terms.length === 0) return true;
	const document = session.searchText || [
		session.cwd,
		session.name ?? "",
		session.model ?? "",
		session.firstPrompt,
		session.lastReply,
		session.allMessagesText,
	]
		.join("\n")
		.toLocaleLowerCase();
	return terms.every((term) => document.includes(term));
}

export function filterSessions(sessions: readonly GlobalSession[], query: string): GlobalSession[] {
	return sessions.filter((session) => matchesSession(session, query));
}

export function findMatchSnippet(session: GlobalSession, query: string, maxChars = 180): string | undefined {
	const terms = queryTerms(query).sort((a, b) => b.length - a.length);
	if (terms.length === 0) return undefined;

	const candidates = [
		session.name ?? "",
		session.firstPrompt,
		session.lastReply,
		session.allMessagesText,
		session.cwd,
		session.model ?? "",
	]
		.map(normalizeText)
		.filter(Boolean);

	for (const candidate of candidates) {
		const lower = candidate.toLocaleLowerCase();
		const matchIndex = terms.reduce<number | undefined>((best, term) => {
			const index = lower.indexOf(term);
			if (index < 0) return best;
			return best === undefined ? index : Math.min(best, index);
		}, undefined);
		if (matchIndex === undefined) continue;

		const start = Math.max(0, matchIndex - Math.floor(maxChars / 3));
		const end = Math.min(candidate.length, start + maxChars);
		return `${start > 0 ? "…" : ""}${candidate.slice(start, end)}${end < candidate.length ? "…" : ""}`;
	}

	return undefined;
}
