import { isAbsolute } from "node:path";
import type { Awf2Workflow, Awf2Diagnostic, Awf2Stage } from "./awf2-types.js";
import { awf2Diag } from "./awf2-types.js";
import { collectExpressionStageRefs, isPlausibleExpression } from "./awf2-expr.js";

function isHumanOrDecision(stage: Awf2Stage): boolean {
  return stage.kind === "human" || stage.kind === "decision";
}

function hasDecisionCatchAll(stage: Awf2Stage): boolean {
  if (stage.kind !== "decision") return true;
  return stage.routes.some((r) => r.when.trim() === "true");
}

function buildTransitionAdj(workflow: Awf2Workflow): ReadonlyMap<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const t of workflow.transitions ?? []) {
    let targets = adj.get(t.from);
    if (!targets) {
      targets = [];
      adj.set(t.from, targets);
    }
    targets.push(t.to);
  }
  return adj;
}

function outboundNeighbors(
  stageId: string,
  stageMap: ReadonlyMap<string, Awf2Stage>,
  transitionAdj: ReadonlyMap<string, string[]>,
): string[] {
  const stage = stageMap.get(stageId);
  if (!stage) return [];

  if (stage.kind === "human") return stage.options.map((o) => o.to);
  if (stage.kind === "decision") return stage.routes.map((r) => r.to);

  return transitionAdj.get(stageId) ?? [];
}

function reachableFromStart(
  workflow: Awf2Workflow,
  stageMap: ReadonlyMap<string, Awf2Stage>,
  transitionAdj: ReadonlyMap<string, string[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [workflow.start];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    if (seen.has(current)) continue;
    seen.add(current);

    for (const next of outboundNeighbors(current, stageMap, transitionAdj)) {
      if (!seen.has(next)) queue.push(next);
    }
  }

  return seen;
}

export function validateAwf2(workflow: Awf2Workflow): Awf2Diagnostic[] {
  const diags: Awf2Diagnostic[] = [];

  if (workflow.version !== 2) {
    diags.push(awf2Diag("awf2_version", "error", `AWF2 version must be 2, got: ${workflow.version}`));
  }

  const transitionAdj = buildTransitionAdj(workflow);
  const stageMap = new Map<string, Awf2Stage>();
  const stageIds = new Set<string>();
  for (const stage of workflow.stages) {
    if (stageIds.has(stage.id)) {
      diags.push(awf2Diag("awf2_duplicate_stage", "error", `Duplicate stage id: "${stage.id}"`, { node_id: stage.id }));
      continue;
    }
    stageIds.add(stage.id);
    stageMap.set(stage.id, stage);
  }

  if (!stageIds.has(workflow.start)) {
    diags.push(awf2Diag("awf2_start_exists", "error", `start references missing stage: "${workflow.start}"`));
  }

  // Stage-specific validation
  for (const stage of workflow.stages) {
    if (stage.kind === "llm") {
      const hasPrompt = typeof stage.prompt === "string" && stage.prompt.trim().length > 0;
      const hasPromptFile = typeof stage.prompt_file === "string" && stage.prompt_file.trim().length > 0;
      if (hasPrompt === hasPromptFile) {
        diags.push(awf2Diag(
          "awf2_llm_prompt",
          "error",
          `LLM stage "${stage.id}" must define exactly one of prompt or prompt_file.`,
          { node_id: stage.id },
        ));
      }
      if (hasPromptFile && (stage.prompt_file!.includes("..") || isAbsolute(stage.prompt_file!))) {
        diags.push(awf2Diag(
          "awf2_prompt_file_path",
          "error",
          `LLM stage "${stage.id}" prompt_file must be a relative path without directory traversal.`,
          { node_id: stage.id },
        ));
      }
      if (stage.model_profile && !workflow.models?.profile?.[stage.model_profile]) {
        diags.push(awf2Diag(
          "awf2_model_profile",
          "error",
          `Stage "${stage.id}" references unknown model_profile "${stage.model_profile}".`,
          { node_id: stage.id },
        ));
      }
    }

    // Tool command validation — workflow files are trusted (like Makefiles),
    // so we validate for author mistakes (empty commands), not injection.
    // Commands are executed in a shell; see handlers.ts ToolHandler.
    if (stage.kind === "tool") {
      if (!stage.command.trim()) {
        diags.push(awf2Diag(
          "awf2_tool_command",
          "error",
          `Tool stage "${stage.id}" has an empty command.`,
          { node_id: stage.id },
        ));
      }
    }

    if (stage.kind === "human") {
      if (stage.options.length < 2) {
        diags.push(awf2Diag(
          "awf2_human_options",
          "error",
          `Human stage "${stage.id}" must declare at least 2 options.`,
          { node_id: stage.id },
        ));
      }
    }

    if (stage.kind === "decision" && !hasDecisionCatchAll(stage)) {
      diags.push(awf2Diag(
        "awf2_decision_catch_all",
        "error",
        `Decision stage "${stage.id}" must include a catch-all route: when="true".`,
        { node_id: stage.id },
      ));
    }

    if (stage.retry) {
      if (!Number.isInteger(stage.retry.max_attempts) || stage.retry.max_attempts < 1) {
        diags.push(awf2Diag(
          "awf2_retry_max_attempts",
          "error",
          `Stage "${stage.id}" has invalid retry.max_attempts: ${stage.retry.max_attempts}`,
          { node_id: stage.id },
        ));
      }
    }
  }

  // Routing partition rule + transition references
  for (const t of workflow.transitions ?? []) {
    if (!stageIds.has(t.from)) {
      diags.push(awf2Diag("awf2_transition_from", "error", `Transition source "${t.from}" does not exist.`, {
        edge: [t.from, t.to],
      }));
    }
    if (!stageIds.has(t.to)) {
      diags.push(awf2Diag("awf2_transition_to", "error", `Transition target "${t.to}" does not exist.`, {
        edge: [t.from, t.to],
      }));
    }

    const from = stageMap.get(t.from);
    if (from && isHumanOrDecision(from)) {
      diags.push(awf2Diag(
        "awf2_routing_partition",
        "error",
        `Stage "${from.id}" (${from.kind}) must use stage-local routing only; global transitions from this stage are not allowed.`,
        { edge: [t.from, t.to], node_id: from.id },
      ));
    }

    if (t.when && !isPlausibleExpression(t.when)) {
      diags.push(awf2Diag(
        "awf2_expression_syntax",
        "error",
        `Invalid transition expression: ${t.when}`,
        { edge: [t.from, t.to] },
      ));
    }
  }

  // Stage-local targets + expression refs
  for (const stage of workflow.stages) {
    if (stage.kind === "human") {
      for (const option of stage.options) {
        if (!stageIds.has(option.to)) {
          diags.push(awf2Diag(
            "awf2_option_target",
            "error",
            `Human stage "${stage.id}" option "${option.key}" targets missing stage "${option.to}".`,
            { node_id: stage.id, edge: [stage.id, option.to] },
          ));
        }
      }
    }

    if (stage.kind === "decision") {
      for (const route of stage.routes) {
        if (!stageIds.has(route.to)) {
          diags.push(awf2Diag(
            "awf2_route_target",
            "error",
            `Decision stage "${stage.id}" route targets missing stage "${route.to}".`,
            { node_id: stage.id, edge: [stage.id, route.to] },
          ));
        }

        if (!isPlausibleExpression(route.when)) {
          diags.push(awf2Diag(
            "awf2_expression_syntax",
            "error",
            `Invalid decision expression: ${route.when}`,
            { node_id: stage.id, edge: [stage.id, route.to] },
          ));
        }

        for (const ref of collectExpressionStageRefs(route.when)) {
          if (!stageIds.has(ref.stageId)) {
            diags.push(awf2Diag(
              "awf2_expression_stage_ref",
              "error",
              `Expression in stage "${stage.id}" references unknown stage "${ref.stageId}".`,
              { node_id: stage.id },
            ));
          }
        }
      }
    }
  }

  // Global transition expression refs
  for (const t of workflow.transitions ?? []) {
    if (!t.when) continue;
    for (const ref of collectExpressionStageRefs(t.when)) {
      if (!stageIds.has(ref.stageId)) {
        diags.push(awf2Diag(
          "awf2_expression_stage_ref",
          "error",
          `Expression on transition ${t.from} -> ${t.to} references unknown stage "${ref.stageId}".`,
          { edge: [t.from, t.to] },
        ));
      }
    }
  }

  // Reachability + reachable exit
  if (stageIds.has(workflow.start)) {
    const reachable = reachableFromStart(workflow, stageMap, transitionAdj);
    const exitStages = workflow.stages.filter((s) => s.kind === "exit").map((s) => s.id);

    if (!exitStages.some((id) => reachable.has(id))) {
      diags.push(awf2Diag(
        "awf2_reachable_exit",
        "error",
        "No exit stage is reachable from start.",
      ));
    }

    for (const stage of workflow.stages) {
      if (!reachable.has(stage.id)) {
        diags.push(awf2Diag(
          "awf2_reachability",
          "error",
          `Stage "${stage.id}" is unreachable from start.`,
          { node_id: stage.id },
        ));
      }
    }
  }

  return diags;
}

export function validateAwf2OrRaise(workflow: Awf2Workflow): Awf2Diagnostic[] {
  const diags = validateAwf2(workflow);
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    const msg = errors.map((e) => `  [${e.rule}] ${e.message}`).join("\n");
    throw new Error(`AWF2 validation failed:\n${msg}`);
  }
  return diags;
}
