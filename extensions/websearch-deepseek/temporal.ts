export function getSystemTimeZone(): string {
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return isValidTimeZone(timeZone) ? timeZone : "UTC";
}

export function resolveTimeZone(value?: string): string {
	const configuredTimeZone = value?.trim();
	return configuredTimeZone && isValidTimeZone(configuredTimeZone)
		? configuredTimeZone
		: getSystemTimeZone();
}

export function getCurrentLocalDate(now = new Date(), timeZone = getSystemTimeZone()): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: resolveTimeZone(timeZone),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${values.year}-${values.month}-${values.day}`;
}

export function buildCurrentDateHeader(now = new Date(), timeZone = getSystemTimeZone()): string {
	const resolvedTimeZone = resolveTimeZone(timeZone);
	return `Current date: ${getCurrentLocalDate(now, resolvedTimeZone)} (${resolvedTimeZone})`;
}

function isValidTimeZone(timeZone: string | undefined): timeZone is string {
	if (!timeZone) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format();
		return true;
	} catch {
		return false;
	}
}
