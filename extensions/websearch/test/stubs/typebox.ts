export const Type = {
	Object(properties: unknown) {
		return { type: "object", properties };
	},
	String(options?: Record<string, unknown>) {
		return { type: "string", ...options };
	},
};
