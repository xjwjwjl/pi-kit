type SchemaOptions = Record<string, unknown>;

export const Type = {
	Object(properties: Record<string, unknown>, options?: SchemaOptions) {
		return { type: "object", properties, ...options };
	},
	Optional(schema: Record<string, unknown>) {
		return { ...schema, optional: true };
	},
	String(options?: SchemaOptions) {
		return { type: "string", ...options };
	},
	Integer(options?: SchemaOptions) {
		return { type: "integer", ...options };
	},
	Number(options?: SchemaOptions) {
		return { type: "number", ...options };
	},
	Boolean(options?: SchemaOptions) {
		return { type: "boolean", ...options };
	},
	Array(items: unknown, options?: SchemaOptions) {
		return { type: "array", items, ...options };
	},
};
