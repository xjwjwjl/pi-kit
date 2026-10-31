export const Type = {
  Object: (value: unknown) => value,
  Optional: (value: unknown) => value,
  String: (value?: unknown) => value ?? { type: "string" },
  Integer: (value?: unknown) => value ?? { type: "integer" },
  Number: () => ({ type: "number" }),
  Boolean: () => ({ type: "boolean" }),
  Null: () => ({ type: "null" }),
  Array: (items: unknown) => ({ type: "array", items }),
  Literal: (value: unknown) => ({ const: value }),
  Union: (anyOf: unknown[]) => ({ anyOf }),
  Unknown: () => ({})
};
