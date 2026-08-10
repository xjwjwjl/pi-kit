export interface GlobalSession {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstPrompt: string;
	lastReply: string;
	model?: string;
	/** User and assistant text retained for local full-text search only. */
	allMessagesText: string;
	/** Lower-cased searchable projection of the session metadata and text. */
	searchText: string;
}

export type SessionScanPhase = "discovering" | "scanning";

export interface SessionScanProgress {
	phase: SessionScanPhase;
	loaded: number;
	total: number;
	skipped: number;
	discovered: number;
}

export interface SessionScanResult {
	sessions: GlobalSession[];
	totalFiles: number;
	skippedFiles: number;
	aborted: boolean;
}

export type TranscriptRole = "user" | "assistant" | "custom" | "summary";

export interface TranscriptMessage {
	id: string;
	role: TranscriptRole;
	content: string;
	timestamp?: string;
}

export interface SessionTranscript {
	messages: TranscriptMessage[];
	/** Model selected on the current resumable branch, when recorded. */
	model?: string;
	/** Number of alternate branches retained in the source session. */
	alternateBranchCount: number;
}

export interface BrowserState {
	query?: string;
	selectedKey?: string;
	collapsedProjects?: string[];
	view?: "list" | "summary";
}

export type BrowserAction =
	| {
			type: "resume";
			session: GlobalSession;
			state: BrowserState;
		}
	| undefined;
