export const Type = {
  String(options: Record<string, unknown> = {}) {
    return { type: "string", ...options };
  },
  Literal(value: string) {
    return { const: value };
  },
  Union(schemas: unknown[], options: Record<string, unknown> = {}) {
    return { anyOf: schemas, ...options };
  },
  Array(items: Record<string, unknown>, options: Record<string, unknown> = {}) {
    return { type: "array", items, ...options };
  },
  Optional(schema: Record<string, unknown>) {
    return { ...schema, optional: true };
  },
  Object(properties: Record<string, Record<string, unknown>>, options: Record<string, unknown> = {}) {
    const required = Object.entries(properties)
      .filter(([, schema]) => schema.optional !== true)
      .map(([name]) => name);
    const normalizedProperties = Object.fromEntries(
      Object.entries(properties).map(([name, schema]) => {
        const { optional: _optional, ...definition } = schema;
        return [name, definition];
      }),
    );
    return {
      type: "object",
      properties: normalizedProperties,
      required,
      ...options,
    };
  },
};
