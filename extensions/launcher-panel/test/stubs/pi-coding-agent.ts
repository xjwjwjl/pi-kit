/**
 * Minimal stand-in for the @earendil-works/pi-coding-agent runtime values
 * used by the launcher panel. Only loaded by the test suite (see
 * test/pi-loader.ts): at runtime pi provides the real implementations.
 */

export class DynamicBorder {
	constructor(_paint: (text: string) => string) {}
	render(): string[] {
		return ["\u2500"];
	}
	invalidate(): void {}
}
