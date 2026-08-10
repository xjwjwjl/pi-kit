import type { GlobalSession } from "./types.ts";

export interface ProjectGroup {
	key: string;
	cwd: string;
	sessions: GlobalSession[];
	latestActivity: Date;
	isCurrent: boolean;
}

export type SessionTreeRow =
	| {
			kind: "project";
			key: string;
			project: ProjectGroup;
			expanded: boolean;
		}
	| {
			kind: "session";
			key: string;
			project: ProjectGroup;
			session: GlobalSession;
			indexInProject: number;
			totalInProject: number;
		};

export function cwdKey(cwd: string): string {
	return cwd.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLocaleLowerCase();
}

export function projectRowKey(projectKey: string): string {
	return `project:${projectKey}`;
}

export function sessionRowKey(path: string): string {
	return `session:${path}`;
}

export function buildProjectGroups(sessions: readonly GlobalSession[], currentCwd: string): ProjectGroup[] {
	const groups = new Map<string, ProjectGroup>();
	const currentKey = cwdKey(currentCwd);

	for (const session of sessions) {
		const key = cwdKey(session.cwd);
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				cwd: session.cwd,
				sessions: [],
				latestActivity: session.modified,
				isCurrent: key === currentKey,
			};
			groups.set(key, group);
		}
		group.sessions.push(session);
		if (session.modified > group.latestActivity) group.latestActivity = session.modified;
	}

	for (const group of groups.values()) {
		group.sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}
	return [...groups.values()].sort((a, b) => b.latestActivity.getTime() - a.latestActivity.getTime());
}

/** Expand the current project and the most recently active different project on first open. */
export function defaultCollapsedProjects(projects: readonly ProjectGroup[]): Set<string> {
	const expanded = new Set<string>();
	const current = projects.find((project) => project.isCurrent);
	if (current) expanded.add(current.key);
	const recentOther = projects.find((project) => project.key !== current?.key);
	if (recentOther) expanded.add(recentOther.key);
	return new Set(projects.filter((project) => !expanded.has(project.key)).map((project) => project.key));
}

export function flattenProjectGroups(
	projects: readonly ProjectGroup[],
	collapsedProjects: ReadonlySet<string>,
	forceExpanded = false,
): SessionTreeRow[] {
	const rows: SessionTreeRow[] = [];
	for (const project of projects) {
		const expanded = forceExpanded || !collapsedProjects.has(project.key);
		rows.push({ kind: "project", key: projectRowKey(project.key), project, expanded });
		if (!expanded) continue;
		for (const [indexInProject, session] of project.sessions.entries()) {
			rows.push({
				kind: "session",
				key: sessionRowKey(session.path),
				project,
				session,
				indexInProject,
				totalInProject: project.sessions.length,
			});
		}
	}
	return rows;
}
