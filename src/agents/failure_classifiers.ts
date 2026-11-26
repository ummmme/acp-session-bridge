import type { AgentMap } from "./config.ts";

export interface FailureClassificationContext {
  agentId: string;
  model?: string;
  stage: string;
  acpCode?: number;
  errorMessage?: string;
  errorData?: unknown;
  stderrTail?: string;
}

export interface FailureClassification {
  reason: "rate_limited";
  source: string;
  evidence: "structured" | "message_heuristic";
}

export type AgentFailureClassifier = (
  context: FailureClassificationContext,
) => FailureClassification | undefined;

export type AgentFailureClassifiers = Record<string, AgentFailureClassifier>;

/** Classifiers are selected by optional agent profile metadata. */
export function classifyAgentFailure(
  agents: AgentMap,
  classifiers: AgentFailureClassifiers,
  agentId: string,
  context: FailureClassificationContext,
): FailureClassification | undefined {
  return classifyProfileFailure(
    agents[agentId]?.failureClassifier,
    classifiers,
    context,
  );
}

export function classifyProfileFailure(
  classifierId: string | undefined,
  classifiers: AgentFailureClassifiers,
  context: FailureClassificationContext,
): FailureClassification | undefined {
  if (!classifierId) return undefined;
  const classifier = classifiers[classifierId];
  if (!classifier) return undefined;
  try {
    return classifier(context);
  } catch {
    // Enrichment must never prevent the generic task failure from being returned.
    return undefined;
  }
}
