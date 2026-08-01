const RELATIVE_TIME_PATTERN = /(?:\btoday\b|\bcurrent\b|\blatest\b|\blive\b|\bnow\b|\byesterday\b|\btomorrow\b|\bday after tomorrow\b|\bthis week\b|\bnext week\b|\blast week\b|\bthis month\b|\bnext month\b|今天|今日|当前|目前|最新|实时|现时|昨天|昨日|明天|明日|后天|本周|这周|下周|上周|本月|下月)/i;

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

export function buildCurrentDateInstruction(now = new Date(), timeZone = getSystemTimeZone()): string {
	const resolvedTimeZone = resolveTimeZone(timeZone);
	const date = getCurrentLocalDate(now, resolvedTimeZone);
	return `Current date and time zone: ${date} (${resolvedTimeZone}). Interpret relative dates such as today, yesterday, tomorrow, this week, next week, current, and latest from this context. For time-sensitive requests, use this exact date and time zone; prefer primary or official sources, state the source's as-of date/time, and do not call information current, latest, or today when freshness cannot be verified. Do not invent or reuse a conflicting historical date from model memory unless the user explicitly requests historical data.`;
}

export function addCurrentDateContext(text: string, now = new Date(), timeZone = getSystemTimeZone()): string {
	if (!RELATIVE_TIME_PATTERN.test(text)) return text;
	return `${text}\n\n${buildCurrentDateInstruction(now, timeZone)}`;
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
