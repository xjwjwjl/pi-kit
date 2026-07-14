export const Type = {
	Object: (properties: unknown) => ({ type: "object", properties }),
	String: (options: unknown = {}) => ({ type: "string", ...options }),
	Optional: (schema: unknown) => ({ ...schema, optional: true }),
};
