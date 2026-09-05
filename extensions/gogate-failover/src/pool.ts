import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { FailoverConfig } from "./config.ts";

export function modelKey(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function matchesReference(model: Model<any>, reference: string, provider: string): boolean {
  return reference === modelKey(model)
    || reference === model.id
    || reference === `${provider}/${model.id}`;
}

function dedupeModels(models: Iterable<Model<any>>): Model<any>[] {
  const seen = new Set<string>();
  const result: Model<any>[] = [];
  for (const model of models) {
    const key = modelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

/** Resolve the failover pool while respecting enabledModels/scopedModels. */
export function resolvePool(ctx: ExtensionContext, config: FailoverConfig): Model<any>[] {
  if (ctx.model?.provider !== config.provider) return [];

  const scoped = ctx.scopedModels
    .filter(({ model }) => model.provider === config.provider)
    .map(({ model }) => model);

  const available = ctx.modelRegistry.getAvailable().filter((model) => model.provider === config.provider);
  let pool: Model<any>[];

  if (config.models?.length) {
    // An explicit pool is an opt-in override and may intentionally include a
    // model not present in enabledModels (for example, GLM as a last resort).
    pool = config.models.flatMap((reference) =>
      available.filter((model) => matchesReference(model, reference, config.provider)),
    );
  } else {
    pool = scoped.length > 0 ? scoped : available;
  }

  // Manual / restored selections may be outside the current scoped list. Keep
  // the active model in the pool so a failure can still rotate away from it.
  if (ctx.model.provider === config.provider) {
    pool = [ctx.model, ...pool];
  }

  return dedupeModels(pool);
}

export function nextCandidate(
  pool: readonly Model<any>[],
  failedModel: Model<any>,
  attempted: ReadonlySet<string>,
  failedUntil: ReadonlyMap<string, number>,
  now: number,
): Model<any> | undefined {
  if (pool.length < 2) return undefined;

  const failedKey = modelKey(failedModel);
  const startIndex = Math.max(0, pool.findIndex((model) => modelKey(model) === failedKey));

  for (let offset = 1; offset <= pool.length; offset += 1) {
    const candidate = pool[(startIndex + offset) % pool.length];
    const key = modelKey(candidate);
    if (key === failedKey || attempted.has(key)) continue;
    if ((failedUntil.get(key) ?? 0) > now) continue;
    return candidate;
  }

  return undefined;
}
