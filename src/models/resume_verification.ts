import type { AgentDefinition } from "../agents/config.ts";
import {
  DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS,
  type SessionManager,
} from "../sessions/manager.ts";
import {
  advertisedOptionValues,
  discoverAdvertisedModels,
  isModelOption,
} from "./discovery.ts";
import { isModelAllowed } from "./policy.ts";

function remainingConfigWait(deadline: number): number {
  return Math.max(0, deadline - performance.now());
}

function configOption(
  options: Array<Record<string, unknown>>,
  configId: string,
) {
  return options.find((item) => item.id === configId);
}

/**
 * Read the current raw thought setting from a verified config option snapshot.
 * The caller supplies the config ID; no normalized thinking-effort mapping is
 * consulted, so provider-specific thought settings can be bookmarked as-is.
 */
export function extractVerifiedRawThoughtConfig(
  verifiedOptions: Array<Record<string, unknown>>,
  configId: string,
): { configId: string; value: string } | undefined {
  const option = configOption(verifiedOptions, configId);
  if (
    option?.type !== "select" ||
    typeof option.currentValue !== "string" ||
    !advertisedOptionValues(option).includes(option.currentValue)
  ) {
    return undefined;
  }
  return { configId, value: option.currentValue };
}

async function waitForExactConfigOption(
  manager: SessionManager,
  sessionId: string,
  configId: string,
  expectedValue: string,
  deadline: number,
  label: string,
  requireCurrent = false,
): Promise<Array<Record<string, unknown>>> {
  const matches = (options: Array<Record<string, unknown>>) => {
    const option = configOption(options, configId);
    return (
      option?.type === "select" &&
      typeof option.currentValue === "string" &&
      advertisedOptionValues(option).includes(expectedValue) &&
      (!requireCurrent || option.currentValue === expectedValue)
    );
  };
  let options = manager.getSessionSnapshot(sessionId).configOptions;
  if (!matches(options)) {
    options = await manager.waitForConfigOptions(
      sessionId,
      matches,
      remainingConfigWait(deadline),
    );
  }
  if (!matches(options)) {
    throw new Error(`Could not verify expected ${label} '${expectedValue}'`);
  }
  return options;
}

async function waitForConfigIds(
  manager: SessionManager,
  sessionId: string,
  configIds: string[],
  deadline: number,
): Promise<Array<Record<string, unknown>>> {
  const matches = (options: Array<Record<string, unknown>>) =>
    configIds.every((id) => configOption(options, id) !== undefined);
  let options = manager.getSessionSnapshot(sessionId).configOptions;
  if (!matches(options)) {
    options = await manager.waitForConfigOptions(
      sessionId,
      matches,
      remainingConfigWait(deadline),
    );
  }
  if (!matches(options)) {
    const missing = configIds.filter((id) => !configOption(options, id));
    throw new Error(`Could not verify config option(s): ${missing.join(", ")}`);
  }
  return options;
}

async function waitForExactModel(
  manager: SessionManager,
  sessionId: string,
  agent: AgentDefinition,
  expectedModel: string,
  deadline: number,
): Promise<{
  options: Array<Record<string, unknown>>;
  configId: string;
}> {
  const matches = (options: Array<Record<string, unknown>>) => {
    const model = discoverAdvertisedModels(options, agent).find(
      (candidate) => candidate.id === expectedModel,
    );
    const option = model && configOption(options, model.configId);
    return !!model && typeof option?.currentValue === "string";
  };
  let options = manager.getSessionSnapshot(sessionId).configOptions;
  if (!matches(options)) {
    options = await manager.waitForConfigOptions(
      sessionId,
      matches,
      remainingConfigWait(deadline),
    );
  }
  const model = discoverAdvertisedModels(options, agent).find(
    (candidate) => candidate.id === expectedModel,
  );
  if (
    !model ||
    typeof configOption(options, model.configId)?.currentValue !== "string"
  ) {
    throw new Error(`Could not verify expected model '${expectedModel}'`);
  }
  return { options, configId: model.configId };
}

async function setConfigOptionWithinDeadline(
  manager: SessionManager,
  sessionId: string,
  configId: string,
  value: string,
  deadline: number,
): Promise<void> {
  const remaining = remainingConfigWait(deadline);
  if (remaining <= 0) throw new Error("Configuration verification timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      manager.setConfigOption(sessionId, configId, value).then(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Configuration verification timed out")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function verifyLoadConfiguration(
  manager: SessionManager,
  sessionId: string,
  agent: AgentDefinition,
  expectedModel: string | undefined,
  expectedThinkingEffort: string | undefined,
  expectedConfig: Record<string, string> | undefined,
): Promise<Array<Record<string, unknown>>> {
  const deadline = performance.now() + DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS;
  const policy = agent.models ?? {};
  if (expectedModel !== undefined && !isModelAllowed(policy, expectedModel)) {
    throw new Error(`Model '${expectedModel}' is denied by model policy`);
  }

  // Resolve every requested config ID before changing anything. This makes
  // model/config conflicts independent of object field order and lets the live
  // catalog identify a model option that was not present in the first update.
  const expectedConfigs = new Map(Object.entries(expectedConfig ?? {}));
  let options = manager.getSessionSnapshot(sessionId).configOptions;
  const configIds = [...expectedConfigs.keys()];
  if (
    configIds.length &&
    !expectedModel &&
    !configIds.some(
      (id) =>
        id === agent.modelConfigId ||
        options.some(
          (option) => option.id === id && isModelOption(option, agent),
        ),
    )
  ) {
    options = await waitForConfigIds(manager, sessionId, configIds, deadline);
  }

  const configuredModelEntries = [...expectedConfigs].filter(([id]) => {
    const option = configOption(options, id);
    return (
      (option !== undefined && isModelOption(option, agent)) ||
      id === agent.modelConfigId
    );
  });
  if (configuredModelEntries.length > 1) {
    throw new Error(
      "Only one ACP model config option may be selected per request",
    );
  }
  const [initialModelConfigId, initialConfiguredModel] =
    configuredModelEntries[0] ?? [];
  if (
    expectedModel !== undefined &&
    initialConfiguredModel !== undefined &&
    initialConfiguredModel !== expectedModel
  ) {
    throw new Error("Expected config model conflicts with expected model");
  }

  const effectiveExpectedModel = expectedModel ?? initialConfiguredModel;
  let modelConfigId: string | undefined;
  if (effectiveExpectedModel !== undefined) {
    if (!isModelAllowed(policy, effectiveExpectedModel)) {
      throw new Error(
        `Model '${effectiveExpectedModel}' is denied by model policy`,
      );
    }
    const exactModel = await waitForExactModel(
      manager,
      sessionId,
      agent,
      effectiveExpectedModel,
      deadline,
    );
    options = exactModel.options;
    modelConfigId = exactModel.configId;

    // The advertised catalog is authoritative for the model's config ID. An
    // option can arrive before its model category metadata, so resolve the
    // request config against that catalog before any config write.
    const resolvedModelEntries = [...expectedConfigs].filter(([id]) => {
      const option = configOption(options, id);
      return (
        id === modelConfigId ||
        (option !== undefined && isModelOption(option, agent)) ||
        id === agent.modelConfigId
      );
    });
    if (resolvedModelEntries.length > 1) {
      throw new Error(
        "Only one ACP model config option may be selected per request",
      );
    }
    const [resolvedModelConfigId, resolvedConfiguredModel] =
      resolvedModelEntries[0] ?? [];
    if (
      resolvedConfiguredModel !== undefined &&
      resolvedConfiguredModel !== effectiveExpectedModel
    ) {
      throw new Error("Expected config model conflicts with expected model");
    }
    if (
      initialModelConfigId !== undefined &&
      initialModelConfigId !== modelConfigId
    ) {
      throw new Error(
        "Expected config model conflicts with advertised model option",
      );
    }
    if (
      resolvedModelConfigId !== undefined &&
      resolvedModelConfigId !== modelConfigId
    ) {
      throw new Error(
        "Expected config model conflicts with advertised model option",
      );
    }
    if (resolvedModelConfigId === undefined) {
      expectedConfigs.set(modelConfigId, effectiveExpectedModel);
    }
  }

  if (expectedThinkingEffort !== undefined) {
    const mapping = policy.thinkingEffort;
    const value =
      mapping?.values[expectedThinkingEffort as keyof typeof mapping.values];
    if (!mapping || typeof value !== "string") {
      throw new Error(
        `No exact thinking configuration is mapped for '${expectedThinkingEffort}'`,
      );
    }
    const configuredThought = expectedConfigs.get(mapping.configOption);
    if (configuredThought !== undefined && configuredThought !== value) {
      throw new Error(
        "Expected config thought value conflicts with thinkingEffort",
      );
    }
    expectedConfigs.set(mapping.configOption, value);
  }

  // Apply the model first. ACP providers may reset auxiliary settings when the
  // model changes, so thought and other config values are verified afterward.
  if (effectiveExpectedModel !== undefined && modelConfigId !== undefined) {
    options = await waitForExactConfigOption(
      manager,
      sessionId,
      modelConfigId,
      effectiveExpectedModel,
      deadline,
      "model",
    );
    const currentModel = configOption(options, modelConfigId)?.currentValue;
    if (currentModel !== effectiveExpectedModel) {
      await setConfigOptionWithinDeadline(
        manager,
        sessionId,
        modelConfigId,
        effectiveExpectedModel,
        deadline,
      );
      options = manager.getSessionSnapshot(sessionId).configOptions;
    }
    options = await waitForExactConfigOption(
      manager,
      sessionId,
      modelConfigId,
      effectiveExpectedModel,
      deadline,
      "model",
      true,
    );
  }

  for (const [id, value] of expectedConfigs) {
    if (id === modelConfigId && value === effectiveExpectedModel) continue;
    options = await waitForExactConfigOption(
      manager,
      sessionId,
      id,
      value,
      deadline,
      "thinking configuration",
    );
    const option = configOption(options, id);
    if (
      option &&
      isModelOption(option, agent) &&
      !isModelAllowed(policy, value)
    ) {
      throw new Error(`Model '${value}' is denied by model policy`);
    }
    if (option?.currentValue !== value) {
      await setConfigOptionWithinDeadline(
        manager,
        sessionId,
        id,
        value,
        deadline,
      );
      options = manager.getSessionSnapshot(sessionId).configOptions;
    }
    options = await waitForExactConfigOption(
      manager,
      sessionId,
      id,
      value,
      deadline,
      "thinking configuration",
      true,
    );
  }

  // Assert the complete requested selection against one fresh snapshot. The
  // returned options are that snapshot and can be used as verified state.
  options = manager.getSessionSnapshot(sessionId).configOptions;
  if (effectiveExpectedModel !== undefined) {
    const finalModel = discoverAdvertisedModels(options, agent).find(
      (candidate) => candidate.id === effectiveExpectedModel,
    );
    const value =
      finalModel && configOption(options, finalModel.configId)?.currentValue;
    if (!finalModel || value !== effectiveExpectedModel) {
      throw new Error(
        `Could not verify expected model '${effectiveExpectedModel}'`,
      );
    }
  }
  for (const [id, value] of expectedConfigs) {
    const option = configOption(options, id);
    if (
      option?.type !== "select" ||
      option.currentValue !== value ||
      !advertisedOptionValues(option).includes(value)
    ) {
      throw new Error(
        `Could not verify expected config '${id}' value '${value}'`,
      );
    }
  }
  return options;
}
