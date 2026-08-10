export interface SensitiveScanResult {
	hasSensitive: boolean;
	patterns: string[];
}

/**
 * Lightweight scan for known secret patterns in command output.
 * Only reports well-known, low-false-positive patterns; never modifies text.
 */
export function scanSensitiveContent(text: string): SensitiveScanResult {
	const patterns: string[] = [];

	if (/-----BEGIN(?:\s[A-Z]+)?\sPRIVATE\sKEY-----/.test(text)) {
		patterns.push("private_key");
	}
	if (/AKIA[0-9A-Z]{16}/.test(text)) {
		patterns.push("aws_access_key");
	}
	if (/(?:secret|password|passwd|token|apikey|api_key)\s*[=:]\s*\S{8,}/i.test(text)) {
		patterns.push("credential_assignment");
	}
	if (/\b(?:mongodb|mysql|postgres(?:ql)?|redis):\/\/[^\s]*@/i.test(text)) {
		patterns.push("db_connection_string");
	}
	if (/Bearer\s+[\w.-]{20,}/.test(text)) {
		patterns.push("bearer_token");
	}
	if (/Authorization:\s*\S{20,}/i.test(text)) {
		patterns.push("authorization_header");
	}

	return {
		hasSensitive: patterns.length > 0,
		patterns: [...new Set(patterns)],
	};
}
