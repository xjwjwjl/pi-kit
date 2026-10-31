import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type StreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getScenario, loadScenarioFile, type ScenarioDefinition, type ScriptedStep } from "./scenario.ts";

export const SCRIPTED_PROVIDER_ID = "linear-todo-scripted";
export const SCRIPTED_MODEL_ID = "linear-todo-scripted";
export const SCRIPTED_API = "linear-todo-scripted";
export const SCRIPTED_ABORT_TOOL = "linear_todo_abort_probe";

const DEFAULT_SCENARIO = "plan-complete";
const DEFAULT_SCENARIO_FILE = fileURLToPath(new URL("./scenarios/deterministic.json", import.meta.url));

export type ScriptedModel = Model<typeof SCRIPTED_API>;

export const SCRIPTED_MODEL: ScriptedModel = {
  id: SCRIPTED_MODEL_ID,
  name: "Linear Todo Scripted Model",
  api: SCRIPTED_API,
  provider: SCRIPTED_PROVIDER_ID,
  baseUrl: "http://127.0.0.1/linear-todo-scripted",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function createMessage(model: ScriptedModel): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: SCRIPTED_API,
    provider: SCRIPTED_PROVIDER_ID,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function abortError(): Error {
  return new Error("The scripted provider was aborted.");
}

async function waitForDelay(milliseconds: number | undefined, signal: AbortSignal | undefined): Promise<void> {
  if (!milliseconds) return;
  if (signal?.aborted) throw abortError();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A bounded, signal-aware fixture: no subprocesses or business-side effects to leak on abort. */
export function createAbortProbe(): ToolDefinition {
  return {
    name: SCRIPTED_ABORT_TOOL,
    label: "Abort probe",
    description: "Wait briefly so the offline runner can exercise an in-flight tool abort.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, onUpdate) {
      if (!signal) throw new Error("The abort probe requires a tool abort signal.");
      try {
        if (!signal.aborted) onUpdate?.({ content: [{ type: "text", text: "Abort probe is waiting." }], details: { status: "waiting" } });
        await waitForDelay(2_000, signal);
        return { content: [{ type: "text", text: "Abort probe completed normally." }], details: { status: "completed" } };
      } catch (error) {
        if (!signal.aborted) throw error;
        return { content: [{ type: "text", text: "Abort probe received cancellation." }], details: { status: "aborted" }, isError: true };
      }
    },
  };
}

function pushText(output: AssistantMessage, stream: AssistantMessageEventStream, text: string): void {
  const contentIndex = output.content.length;
  output.content.push({ type: "text", text: "" });
  stream.push({ type: "text_start", contentIndex, partial: output });
  const block = output.content[contentIndex];
  if (block?.type !== "text") throw new Error("Scripted provider text block was not created");
  block.text = text;
  if (text) stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

function traceContext(context: Context, callIndex: number): void {
  const traceFile = process.env.LINEAR_TODO_E2E_CONTEXT_TRACE;
  if (!traceFile) return;
  const messages = context.messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) =>
            block.type === "text"
              ? block.text
              : block.type === "toolCall"
                ? { type: block.type, name: block.name, arguments: block.arguments }
                : { type: block.type },
          ),
  }));
  appendFileSync(traceFile, JSON.stringify({ callIndex, messages }) + "\n", "utf8");
}

function pushToolCall(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  step: Extract<ScriptedStep, { type: "toolCall" }>,
  callIndex: number,
): void {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: `scripted-call-${callIndex}`,
    name: step.name,
    arguments: structuredClone(step.arguments) as ToolCall["arguments"],
  };
  const contentIndex = output.content.length;
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

async function playStep(
  stream: AssistantMessageEventStream,
  model: ScriptedModel,
  step: ScriptedStep,
  callIndex: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const output = createMessage(model);
  stream.push({ type: "start", partial: output });

  try {
    await waitForDelay(step.delayMs, signal);
    if (signal?.aborted) throw abortError();

    switch (step.type) {
      case "text":
        pushText(output, stream, step.text);
        output.stopReason = step.stopReason ?? "stop";
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
        return;
      case "toolCall":
        if (step.text) pushText(output, stream, step.text);
        pushToolCall(output, stream, step, callIndex);
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      case "error":
        output.stopReason = "error";
        output.errorMessage = step.message;
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
        return;
      case "abort":
        output.stopReason = "aborted";
        output.errorMessage = step.message ?? "The scripted provider aborted this run.";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
    }
  } catch (error) {
    output.stopReason = "aborted";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: "aborted", error: output });
    stream.end();
  }
}

export default async function scriptedProviderExtension(pi: ExtensionAPI): Promise<void> {
  const scenarioFile = process.env.LINEAR_TODO_E2E_SCENARIO_FILE ?? DEFAULT_SCENARIO_FILE;
  const scenarioName = process.env.LINEAR_TODO_E2E_SCENARIO ?? DEFAULT_SCENARIO;
  const definition: ScenarioDefinition = getScenario(await loadScenarioFile(scenarioFile), scenarioName);
  const configuredOffset = Number(process.env.LINEAR_TODO_E2E_STEP_OFFSET ?? "0");
  const stepOffset = Number.isSafeInteger(configuredOffset) && configuredOffset >= 0 ? configuredOffset : 0;
  let nextStep = stepOffset;
  let callIndex = stepOffset;
  if (definition.steps.some((step) => step.type === "toolCall" && step.name === SCRIPTED_ABORT_TOOL)) {
    pi.registerTool(createAbortProbe());
  }

  const stream = (model: ScriptedModel, context: Context, options?: StreamOptions): AssistantMessageEventStream => {
    const streamResult = createAssistantMessageEventStream();
    const step = definition.steps[nextStep++];
    const currentCall = callIndex++;
    traceContext(context, currentCall);

    if (!step) {
      void playStep(
        streamResult,
        model,
        { type: "error", message: `Scripted scenario ${scenarioName} exhausted at provider call ${currentCall}.` },
        currentCall,
        options?.signal,
      );
      return streamResult;
    }

    void playStep(streamResult, model, step, currentCall, options?.signal);
    return streamResult;
  };

  const provider = createProvider<typeof SCRIPTED_API>({
    id: SCRIPTED_PROVIDER_ID,
    name: "Linear Todo Scripted Provider",
    baseUrl: "http://127.0.0.1/linear-todo-scripted",
    auth: {
      apiKey: {
        name: "Linear Todo E2E scripted credentials",
        async login() {
          return { type: "api_key", key: "scripted" };
        },
        async resolve() {
          return { auth: { apiKey: "scripted" }, source: "scripted provider" };
        },
      },
    },
    models: [SCRIPTED_MODEL],
    api: { stream, streamSimple: stream },
  });

  pi.registerProvider(provider);
}
