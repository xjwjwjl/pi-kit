import { readFile } from "node:fs/promises";

export const MODEL_SCENARIO_SCHEMA_VERSION = 1 as const;

export type ModelTodoExpectation = "avoid" | "recommended" | "required" | "either";
export type ModelRepoChangeExpectation = "none" | "some" | "either";
export type ModelFinalResponseExpectation = "non-empty" | "either";

export interface ModelVerificationCommand {
  name: string;
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface ModelTurn {
  message: string;
  delivery?: "prompt" | "steer" | "followUp";
  afterMs?: number;
}

export interface ModelPlanExpectations {
  minItems?: number;
  maxItems?: number;
  requireVerificationTask?: boolean;
}

export interface ModelScenarioExpectations {
  todo?: ModelTodoExpectation;
  finalTodoPhase?: "active" | "blocked" | "completed" | "none" | "either";
  finalResponse?: ModelFinalResponseExpectation;
  repoChange?: ModelRepoChangeExpectation;
  plan?: ModelPlanExpectations;
}

export type ModelScenarioOracle = "outcome" | "process";

export interface ModelScenarioDefinition {
  description?: string;
  category: string;
  /**
   * `outcome` scenarios are scored by a task oracle that must fail before the run and pass after it.
   * `process` scenarios have no code outcome (the deliverable is the Todo state itself), so they are
   * gated on regression + integrity only and excluded from the A/B quality average.
   */
  oracle: ModelScenarioOracle;
  turns: ModelTurn[];
  /** Task-specific acceptance tests. Required for `outcome` scenarios. */
  acceptance?: ModelVerificationCommand[];
  /** Directory under `e2e/fixtures/acceptance/` copied into the workspace for the run. */
  acceptanceFixture?: string;
  /** Pre-existing suite. Must pass before and after the run. */
  regression?: ModelVerificationCommand[];
  restartAfterTurn?: number;
  compactAfterTurn?: number;
  abortAfterMs?: number;
  expect?: ModelScenarioExpectations;
}

export interface ModelScenarioFile {
  schemaVersion: typeof MODEL_SCENARIO_SCHEMA_VERSION;
  scenarios: Record<string, ModelScenarioDefinition>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer`);
  return value as number;
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function parseTurn(value: unknown, index: number, scenarioName: string): ModelTurn {
  if (!isRecord(value)) throw new Error(`scenarios.${scenarioName}.turns[${index}] must be an object`);
  const delivery = value.delivery;
  if (delivery !== undefined && delivery !== "prompt" && delivery !== "steer" && delivery !== "followUp") {
    throw new Error(`scenarios.${scenarioName}.turns[${index}].delivery is invalid`);
  }
  const afterMs = nonNegativeInteger(value.afterMs, `scenarios.${scenarioName}.turns[${index}].afterMs`);
  return {
    message: requiredString(value.message, `scenarios.${scenarioName}.turns[${index}].message`),
    ...(delivery === undefined ? {} : { delivery }),
    ...(afterMs === undefined ? {} : { afterMs }),
  };
}

function parseCommandList(value: unknown, field: string, scenarioName: string): ModelVerificationCommand[] | undefined {
  if (value === undefined) return undefined;
  const path = `scenarios.${scenarioName}.${field}`;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`${path}[${index}] must be an object`);
    const rawArgs = raw.args;
    if (!Array.isArray(rawArgs) || !rawArgs.every((arg) => typeof arg === "string")) {
      throw new Error(`${path}[${index}].args must be a string array`);
    }
    const timeoutMs = nonNegativeInteger(raw.timeoutMs, `${path}[${index}].timeoutMs`);
    return {
      name: requiredString(raw.name, `${path}[${index}].name`),
      command: requiredString(raw.command, `${path}[${index}].command`),
      args: [...rawArgs] as string[],
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  });
}

function parsePlanExpectations(value: unknown, scenarioName: string): ModelPlanExpectations | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`scenarios.${scenarioName}.expect.plan must be an object`);
  const minItems = positiveInteger(value.minItems, `scenarios.${scenarioName}.expect.plan.minItems`);
  const maxItems = positiveInteger(value.maxItems, `scenarios.${scenarioName}.expect.plan.maxItems`);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    throw new Error(`scenarios.${scenarioName}.expect.plan.minItems cannot exceed maxItems`);
  }
  if (value.requireVerificationTask !== undefined && typeof value.requireVerificationTask !== "boolean") {
    throw new Error(`scenarios.${scenarioName}.expect.plan.requireVerificationTask must be a boolean`);
  }
  return {
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(value.requireVerificationTask === undefined ? {} : { requireVerificationTask: value.requireVerificationTask }),
  };
}

function parseExpectations(value: unknown, scenarioName: string): ModelScenarioExpectations | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`scenarios.${scenarioName}.expect must be an object`);
  const todo = value.todo;
  if (todo !== undefined && todo !== "avoid" && todo !== "recommended" && todo !== "required" && todo !== "either") {
    throw new Error(`scenarios.${scenarioName}.expect.todo is invalid`);
  }
  const finalTodoPhase = value.finalTodoPhase;
  if (
    finalTodoPhase !== undefined &&
    finalTodoPhase !== "active" &&
    finalTodoPhase !== "blocked" &&
    finalTodoPhase !== "completed" &&
    finalTodoPhase !== "none" &&
    finalTodoPhase !== "either"
  ) {
    throw new Error(`scenarios.${scenarioName}.expect.finalTodoPhase is invalid`);
  }
  const finalResponse = value.finalResponse;
  if (finalResponse !== undefined && finalResponse !== "non-empty" && finalResponse !== "either") {
    throw new Error(`scenarios.${scenarioName}.expect.finalResponse is invalid`);
  }
  const repoChange = value.repoChange;
  if (repoChange !== undefined && repoChange !== "none" && repoChange !== "some" && repoChange !== "either") {
    throw new Error(`scenarios.${scenarioName}.expect.repoChange is invalid`);
  }
  return {
    ...(todo === undefined ? {} : { todo }),
    ...(finalTodoPhase === undefined ? {} : { finalTodoPhase }),
    ...(finalResponse === undefined ? {} : { finalResponse }),
    ...(repoChange === undefined ? {} : { repoChange }),
    ...(value.plan === undefined ? {} : { plan: parsePlanExpectations(value.plan, scenarioName)! }),
  };
}

export function parseModelScenarioFile(value: unknown): ModelScenarioFile {
  if (!isRecord(value)) throw new Error("Model scenario file must contain an object");
  if (value.schemaVersion !== MODEL_SCENARIO_SCHEMA_VERSION) {
    throw new Error(`Unsupported model scenario schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (!isRecord(value.scenarios) || Object.keys(value.scenarios).length === 0) {
    throw new Error("Model scenario file must contain at least one scenario");
  }

  const scenarios: Record<string, ModelScenarioDefinition> = {};
  for (const [name, rawScenario] of Object.entries(value.scenarios)) {
    if (!isRecord(rawScenario)) throw new Error(`scenarios.${name} must be an object`);
    const rawTurns = rawScenario.turns;
    if (!Array.isArray(rawTurns) || rawTurns.length === 0) throw new Error(`scenarios.${name}.turns must be non-empty`);
    const restartAfterTurn = nonNegativeInteger(rawScenario.restartAfterTurn, `scenarios.${name}.restartAfterTurn`);
    const compactAfterTurn = nonNegativeInteger(rawScenario.compactAfterTurn, `scenarios.${name}.compactAfterTurn`);
    const abortAfterMs = nonNegativeInteger(rawScenario.abortAfterMs, `scenarios.${name}.abortAfterMs`);
    const acceptance = parseCommandList(rawScenario.acceptance, "acceptance", name);
    const acceptanceFixture =
      rawScenario.acceptanceFixture === undefined
        ? undefined
        : requiredString(rawScenario.acceptanceFixture, `scenarios.${name}.acceptanceFixture`);
    if (acceptanceFixture !== undefined && !/^[A-Za-z0-9_-]+$/.test(acceptanceFixture)) {
      throw new Error(`scenarios.${name}.acceptanceFixture must be a plain directory name`);
    }
    const declaredOracle = rawScenario.oracle;
    if (declaredOracle !== undefined && declaredOracle !== "outcome" && declaredOracle !== "process") {
      throw new Error(`scenarios.${name}.oracle is invalid`);
    }
    const oracle: ModelScenarioOracle = declaredOracle ?? (acceptance && acceptance.length > 0 ? "outcome" : "process");
    if (oracle === "outcome" && (acceptance === undefined || acceptance.length === 0)) {
      throw new Error(`scenarios.${name} is an outcome scenario but declares no acceptance commands`);
    }
    if (oracle === "outcome" && acceptanceFixture === undefined) {
      throw new Error(`scenarios.${name} is an outcome scenario but declares no acceptanceFixture`);
    }
    if (oracle === "process" && acceptance !== undefined && acceptance.length > 0) {
      throw new Error(`scenarios.${name} is a process scenario but declares acceptance commands`);
    }
    scenarios[name] = {
      ...(typeof rawScenario.description === "string" ? { description: rawScenario.description } : {}),
      category: requiredString(rawScenario.category, `scenarios.${name}.category`),
      oracle,
      turns: rawTurns.map((turn, index) => parseTurn(turn, index, name)),
      ...(acceptance === undefined ? {} : { acceptance }),
      ...(acceptanceFixture === undefined ? {} : { acceptanceFixture }),
      regression: parseCommandList(rawScenario.regression, "regression", name),
      ...(restartAfterTurn === undefined ? {} : { restartAfterTurn }),
      ...(compactAfterTurn === undefined ? {} : { compactAfterTurn }),
      ...(abortAfterMs === undefined ? {} : { abortAfterMs }),
      expect: parseExpectations(rawScenario.expect, name),
    };
  }

  return { schemaVersion: MODEL_SCENARIO_SCHEMA_VERSION, scenarios };
}

export async function loadModelScenarioFile(filePath: string): Promise<ModelScenarioFile> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Failed to read model scenario file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseModelScenarioFile(value);
}

export function getModelScenario(file: ModelScenarioFile, name: string): ModelScenarioDefinition {
  const scenario = file.scenarios[name];
  if (!scenario) throw new Error(`Unknown model scenario ${JSON.stringify(name)}. Available: ${Object.keys(file.scenarios).join(", ")}`);
  return scenario;
}
