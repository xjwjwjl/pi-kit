import { readFile } from "node:fs/promises";

export const SCRIPTED_SCENARIO_SCHEMA_VERSION = 1 as const;

export type ScriptedTextStep = {
  type: "text";
  text: string;
  stopReason?: "stop" | "length";
  delayMs?: number;
};

export type ScriptedToolCallStep = {
  type: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
  text?: string;
  delayMs?: number;
};

export type ScriptedErrorStep = {
  type: "error";
  message: string;
  delayMs?: number;
};

export type ScriptedAbortStep = {
  type: "abort";
  message?: string;
  delayMs?: number;
};

export type ScriptedStep = ScriptedTextStep | ScriptedToolCallStep | ScriptedErrorStep | ScriptedAbortStep;

export interface ScenarioExpectations {
  todoActions?: string[];
  todoToolCalls?: number;
  autoContinueMessages?: number;
  finalTodoPhase?: "active" | "blocked" | "completed" | "none";
  finalTodoCursor?: number;
  finalTodoItemCount?: number;
}

export interface ScenarioDefinition {
  description?: string;
  prompt: string;
  steps: ScriptedStep[];
  expect?: ScenarioExpectations;
}

export interface ScenarioFile {
  schemaVersion: typeof SCRIPTED_SCENARIO_SCHEMA_VERSION;
  scenarios: Record<string, ScenarioDefinition>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalDelay(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function parseStep(value: unknown, index: number): ScriptedStep {
  if (!isRecord(value)) throw new Error(`steps[${index}] must be an object`);
  const type = requiredString(value.type, `steps[${index}].type`);
  const delayMs = optionalDelay(value.delayMs, `steps[${index}].delayMs`);

  switch (type) {
    case "text": {
      const stopReason = value.stopReason;
      if (stopReason !== undefined && stopReason !== "stop" && stopReason !== "length") {
        throw new Error(`steps[${index}].stopReason must be stop or length`);
      }
      return {
        type,
        text: requiredString(value.text, `steps[${index}].text`),
        ...(stopReason === undefined ? {} : { stopReason }),
        ...(delayMs === undefined ? {} : { delayMs }),
      };
    }
    case "toolCall": {
      if (!isRecord(value.arguments)) throw new Error(`steps[${index}].arguments must be an object`);
      return {
        type,
        name: requiredString(value.name, `steps[${index}].name`),
        arguments: structuredClone(value.arguments),
        ...(typeof value.text === "string" ? { text: value.text } : {}),
        ...(delayMs === undefined ? {} : { delayMs }),
      };
    }
    case "error":
      return {
        type,
        message: requiredString(value.message, `steps[${index}].message`),
        ...(delayMs === undefined ? {} : { delayMs }),
      };
    case "abort":
      return {
        type,
        ...(typeof value.message === "string" ? { message: value.message } : {}),
        ...(delayMs === undefined ? {} : { delayMs }),
      };
    default:
      throw new Error(`steps[${index}].type ${JSON.stringify(type)} is unsupported`);
  }
}

function parseExpectations(value: unknown, scenarioName: string): ScenarioExpectations | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`scenarios.${scenarioName}.expect must be an object`);

  const todoActions = value.todoActions;
  if (todoActions !== undefined && (!Array.isArray(todoActions) || !todoActions.every((item) => typeof item === "string"))) {
    throw new Error(`scenarios.${scenarioName}.expect.todoActions must be a string array`);
  }

  const integerFields = ["todoToolCalls", "autoContinueMessages", "finalTodoCursor", "finalTodoItemCount"] as const;
  for (const field of integerFields) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 0)) {
      throw new Error(`scenarios.${scenarioName}.expect.${field} must be a non-negative integer`);
    }
  }

  const finalTodoPhase = value.finalTodoPhase;
  if (
    finalTodoPhase !== undefined &&
    finalTodoPhase !== "active" &&
    finalTodoPhase !== "blocked" &&
    finalTodoPhase !== "completed" &&
    finalTodoPhase !== "none"
  ) {
    throw new Error(`scenarios.${scenarioName}.expect.finalTodoPhase is invalid`);
  }

  return {
    ...(todoActions === undefined ? {} : { todoActions: [...todoActions] as string[] }),
    ...(value.todoToolCalls === undefined ? {} : { todoToolCalls: value.todoToolCalls as number }),
    ...(value.autoContinueMessages === undefined ? {} : { autoContinueMessages: value.autoContinueMessages as number }),
    ...(finalTodoPhase === undefined ? {} : { finalTodoPhase }),
    ...(value.finalTodoCursor === undefined ? {} : { finalTodoCursor: value.finalTodoCursor as number }),
    ...(value.finalTodoItemCount === undefined ? {} : { finalTodoItemCount: value.finalTodoItemCount as number }),
  };
}

export function parseScenarioFile(value: unknown): ScenarioFile {
  if (!isRecord(value)) throw new Error("Scenario file must contain an object");
  if (value.schemaVersion !== SCRIPTED_SCENARIO_SCHEMA_VERSION) {
    throw new Error(`Unsupported scenario schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (!isRecord(value.scenarios) || Object.keys(value.scenarios).length === 0) {
    throw new Error("Scenario file must contain at least one scenario");
  }

  const scenarios: Record<string, ScenarioDefinition> = {};
  for (const [name, rawScenario] of Object.entries(value.scenarios)) {
    if (!isRecord(rawScenario)) throw new Error(`scenarios.${name} must be an object`);
    const rawSteps = rawScenario.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error(`scenarios.${name}.steps must be non-empty`);
    scenarios[name] = {
      ...(typeof rawScenario.description === "string" ? { description: rawScenario.description } : {}),
      prompt: requiredString(rawScenario.prompt, `scenarios.${name}.prompt`),
      steps: rawSteps.map((step, index) => parseStep(step, index)),
      expect: parseExpectations(rawScenario.expect, name),
    };
  }

  return { schemaVersion: SCRIPTED_SCENARIO_SCHEMA_VERSION, scenarios };
}

export async function loadScenarioFile(filePath: string): Promise<ScenarioFile> {
  const content = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse scenario file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseScenarioFile(parsed);
}

export function getScenario(file: ScenarioFile, name: string): ScenarioDefinition {
  const scenario = file.scenarios[name];
  if (!scenario) {
    throw new Error(`Unknown scripted scenario ${JSON.stringify(name)}. Available: ${Object.keys(file.scenarios).join(", ")}`);
  }
  return scenario;
}
