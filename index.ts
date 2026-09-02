/**
 * pi-modes — Claude Code-style mode switching
 *
 * Five modes:
 *   Auto   — Agent decides: simple tasks → do it; complex → plan first, then execute
 *   Plan   — Read-only analysis. Write tools disabled, bash restricted.
 *   Edit   — Full access. No planning phase.
 *   Manual — Full tools, but confirms before EACH tool call
 *   Ask    — No tool calls. Pure Q&A.
 *
 * Commands:
 *   /mode [auto|plan|edit|manual|ask]  — switch or show current
 *   Ctrl+Alt+M                           — cycle modes
 *   --mode <name>                        — CLI flag
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

// ─── Types ──────────────────────────────────────────────────────────────────

type AgentMode = "auto" | "plan" | "edit" | "manual" | "ask";
const MODES: AgentMode[] = ["manual", "edit", "plan", "auto", "ask"];

interface ModeState {
  mode: AgentMode;
  // Plan tracking (used across auto + plan + edit execution)
  planSteps: PlanStep[];
  executing: boolean;
  failureCount: number;
  lastError: string;
  // Saved tool state for restore
  toolsBeforeRestricted?: string[];
}

interface PlanStep {
  step: number;
  text: string;
  completed: boolean;
}

// ─── State ──────────────────────────────────────────────────────────────────

let state: ModeState = {
  mode: "auto", // default mode
  planSteps: [],
  executing: false,
  failureCount: 0,
  lastError: "",
};

let _pi: ExtensionAPI;
const MAX_FAILURES = 3;

// Session allowlist for manual mode
const manualAllowed: Set<string> = new Set();

// ─── Tool sets ──────────────────────────────────────────────────────────────

const EDIT_TOOLS = ["read", "bash", "edit", "write"];
const ALL_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// ─── Bash safety ───────────────────────────────────────────────────────────

const DESTRUCTIVE = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
  /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i, /\btee\b/i, /\btruncate\b/i,
  /\bdd\b/i, /\bshred\b/i,
  /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|ci|link|update|publish|deprecate)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
  /\breboot\b/i, /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
  /\bcurl\s+.*\|(ba)?sh/, /\bwget\s+.*\|(ba)?sh/,
];

const SAFE_CMDS = [
  /^(cat|head|tail|less|more)\b/, /^(grep|rg|find|fd|ls|pwd|echo|printf)\b/,
  /^(wc|sort|uniq|diff|file|stat|du|df|tree)\b/,
  /^(which|whereis|type|env|printenv|uname|whoami|id|date)\b/,
  /^(uptime|ps|top|htop|free|cal)\b/,
  /^git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)/i,
  /^npm\s+(list|ls|view|info|outdated|audit)/i,
  /^yarn\s+(list|info|why|audit)/i,
  /^node\s+--version/i, /^python\s+--version/i,
  /^curl\s/i, /^wget\s+-O\s*-/i,
  /^(jq|sed\s+-n|awk|bat|eza)\b/,
];

function isBashSafe(cmd: string): boolean {
  return !DESTRUCTIVE.some((r) => r.test(cmd)) && SAFE_CMDS.some((r) => r.test(cmd));
}

// ─── Tool management ────────────────────────────────────────────────────────

function restrictTools(): void {
  if (state.toolsBeforeRestricted !== undefined) return; // already saved
  state.toolsBeforeRestricted = _pi.getActiveTools();

  const current = state.toolsBeforeRestricted;
  if (state.mode === "ask") {
    _pi.setActiveTools([]);
  } else if (state.mode === "plan") {
    // Keep read-only tools + non-destructive, plus questionnaire for clarifying questions
    const hasQuestionnaire = _pi.getAllTools().some((t) => t.name === "questionnaire");
    _pi.setActiveTools(
      [...new Set([
        ...current.filter((t) => t !== "edit" && t !== "write"),
        "read", "grep", "find", "ls",
        ...(hasQuestionnaire ? ["questionnaire"] : []),
      ])]
    );
  }
}

function restoreTools(): void {
  if (state.toolsBeforeRestricted !== undefined) {
    _pi.setActiveTools(state.toolsBeforeRestricted);
    state.toolsBeforeRestricted = undefined;
  }
}

// ─── Plan step extraction ──────────────────────────────────────────────────

function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
    .replace(/`([^`]+)`/g, "$1") // Remove inline code
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
  return cleaned;
}

function extractSteps(text: string): PlanStep[] {
  const items: PlanStep[] = [];
  const m = text.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!m) return items;

  const section = text.slice(text.indexOf(m[0]) + m[0].length);
  for (const match of section.matchAll(/^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm)) {
    const raw = match[2].trim().replace(/\*{1,2}$/, "").trim();
    // Skip items that are unlikely to be plan steps (code refs, commands, bullets)
    if (raw.length <= 5 || raw.startsWith("`") || raw.startsWith("/") || raw.startsWith("-")) continue;
    const cleaned = cleanStepText(raw);
    if (cleaned.length < 3) continue;
    items.push({ step: items.length + 1, text: cleaned, completed: false });
  }
  return items;
}

function markDone(text: string, steps: PlanStep[]): number {
  let count = 0;
  for (const m of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const n = Number(m[1]);
    const s = steps.find((s) => s.step === n);
    if (s && !s.completed) { s.completed = true; count++; }
  }
  return count;
}

// ─── Persistence ────────────────────────────────────────────────────────────

function persist(): void {
  _pi.appendEntry("modes-state", {
    mode: state.mode,
    planSteps: state.planSteps,
    executing: state.executing,
    failureCount: state.failureCount,
    lastError: state.lastError,
    toolsBeforeRestricted: state.toolsBeforeRestricted,
  });
}

// ─── UI ─────────────────────────────────────────────────────────────────────

function modeThemeColor(mode: AgentMode) {
  switch (mode) {
    case "auto": return "accent";
    case "plan": return "warning";
    case "edit": return "success";
    case "manual": return "text";
    case "ask":  return "dim";
  }
}

function modeIcon(mode: AgentMode): string {
  switch (mode) {
    case "manual": return "⊘";
    case "edit":   return "✎";
    case "plan":   return "☷";
    case "auto":   return "↻";
    case "ask":    return "?";
  }
}

function modeLabel(mode: AgentMode): string {
  switch (mode) {
    case "auto": return "Auto";
    case "plan": return "Plan";
    case "edit": return "Edit";
    case "manual": return "Manual";
    case "ask":  return "Ask";
  }
}

function updateUI(ctx: ExtensionContext): void {
  const theme = ctx.ui.theme;
  const m = state.mode;
  const hasPlan = state.planSteps.length > 0 && state.executing;
  const status = theme.fg(modeThemeColor(m), `${modeIcon(m)} ${modeLabel(m)}`);

  // Footer status
  if (hasPlan) {
    const done = state.planSteps.filter((s) => s.completed).length;
    const total = state.planSteps.length;
    ctx.ui.setStatus("modes", `${status} ${theme.fg("dim", `[${done}/${total}]`)}`);
  } else {
    ctx.ui.setStatus("modes", `${status}  ${theme.fg("dim", "(Ctrl+Alt+M→ to cycle)")}`);
  }

  // Widget: plan steps
  if (hasPlan) {
    const lines = state.planSteps.map((s) =>
      s.completed
        ? theme.fg("success", "☑ ") + theme.fg("muted", theme.strikethrough(s.text))
        : theme.fg("muted", "☐ ") + s.text
    );
    if (state.failureCount > 0) {
      lines.push("");
      lines.push(theme.fg("warning", `⚠ Failures: ${state.failureCount}/${MAX_FAILURES}`));
    }
    ctx.ui.setWidget("modes-plan", lines);
  } else if (state.planSteps.length > 0 && !state.executing) {
    // Plan ready but not executing
    const lines = state.planSteps.map((s) => theme.fg("muted", `☐ ${s.text}`));
    lines.push("");
    lines.push(theme.fg("dim", "Use /mode edit to start execution"));
    ctx.ui.setWidget("modes-plan", lines);
  } else {
    ctx.ui.setWidget("modes-plan", undefined);
  }
}

// ─── Mode switching ─────────────────────────────────────────────────────────

function switchMode(newMode: AgentMode, ctx: ExtensionContext): void {
  const prev = state.mode;
  state.mode = newMode;

  // Clear execution state when switching away from edit/auto executing
  if (state.executing && (newMode === "plan" || newMode === "ask")) {
    state.executing = false;
    state.failureCount = 0;
  }

  // Clear manual session allowlist on mode switch
  manualAllowed.clear();

  // Apply tool restrictions
  restoreTools();
  if (newMode === "plan" || newMode === "ask") {
    restrictTools();
  }

  updateUI(ctx);
  persist();

  ctx.ui.notify(
    `Mode: ${modeLabel(prev)} → ${modeLabel(newMode)}${newMode === "plan" ? " (read-only)" : newMode === "ask" ? " (no tools)" : newMode === "manual" ? " (confirm each step)" : ""}`,
    "info",
  );
}

function cycleMode(ctx: ExtensionContext): void {
  const idx = MODES.indexOf(state.mode);
  const next = MODES[(idx + 1) % MODES.length]!;
  switchMode(next, ctx);
}

// ─── Auto mode: intelligent context injection ──────────────────────────────

function getAutoContext(): string {
  return `[MODE: AUTO]
You decide the approach based on task complexity:

- SIMPLE (single file edit, quick fix) → Just do it directly. No planning needed.
- COMPLEX (multi-step, multiple files) → First create a numbered plan under "Plan:" header, then IMMEDIATELY execute it step by step. Mark each with [DONE:n]. Do NOT wait for confirmation — just go ahead.
- QUESTION (pure knowledge, no code changes) → Answer directly without tools when possible.

Current capabilities: ${_pi.getActiveTools().join(", ") || "none"}`;
}

function getPlanContext(): string {
  return `[MODE: PLAN — Read-Only]
You CANNOT modify any files. Write/edit tools are disabled.
Bash is restricted to read-only commands (cat, grep, ls, find, git status/log/diff, etc.).

Your job:
1. Analyze the codebase thoroughly
2. Ask clarifying questions with the questionnaire tool when requirements are ambiguous
3. Create a detailed numbered plan under "Plan:" header
4. The user will switch to Edit mode for execution`;
}

function getEditContext(): string {
  if (state.executing && state.planSteps.length > 0) {
    const remaining = state.planSteps.filter((s) => !s.completed);
    const list = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
    const first = remaining[0];
    return `[MODE: EDIT — Executing Plan]
Full tools available. Execute these steps in order. Mark each with [DONE:n].

Remaining:
${list}

${state.failureCount > 0 ? `⚠ ${state.failureCount}/${MAX_FAILURES} failures. Do NOT repeat the same failing operation.` : ""}
${state.failureCount >= MAX_FAILURES ? "PAUSE and ask the user for guidance." : ""}

Next: step ${first?.step ?? "?"} — ${first?.text ?? "continue"}`;
  }
  return `[MODE: EDIT — Full Access]
All tools available. No planning required. Just do it.`;
}

function getManualContext(): string {
  if (state.executing && state.planSteps.length > 0) {
    const remaining = state.planSteps.filter((s) => !s.completed);
    const list = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
    return `[MODE: MANUAL — Step-by-Step Confirmation]
You have full tools available, but the user will confirm EACH action before it runs.

Be explicit about what you intend to do and why.

Remaining plan steps:
${list}`;
  }
  return `[MODE: MANUAL — Step-by-Step Confirmation]
You have full tools available, but the user will confirm EACH action before it runs.

Describe each action clearly: what you will do and why.`;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function modesExtension(pi: ExtensionAPI): void {
  _pi = pi;

  // ── CLI flag ──────────────────────────────────────────────────────────

  pi.registerFlag("mode", {
    description: "Start in a specific mode (auto, plan, edit, ask)",
    type: "string",
    default: "",
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("mode", {
    description: "Switch agent mode: auto | plan | edit | ask",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) {
        // Show current
        const info = MODES.map((m) =>
          m === state.mode ? `→ ${modeLabel(m)}` : `  ${modeLabel(m)}`
        ).join("\n");
        ctx.ui.notify(`Current mode: ${modeLabel(state.mode)}\n\n${info}`, "info");
        return;
      }
      if (MODES.includes(arg as AgentMode)) {
        switchMode(arg as AgentMode, ctx);
      } else {
        ctx.ui.notify(`Unknown mode: ${arg}. Use auto, plan, edit, or ask.`, "error");
      }
    },
  });

  // Sub-commands for convenience
  for (const m of MODES) {
    pi.registerCommand(m, {
      description: `Switch to ${modeLabel(m as AgentMode)} mode`,
      handler: async (_args, ctx) => switchMode(m as AgentMode, ctx),
    });
  }

  // ── Shortcut ──────────────────────────────────────────────────────────

  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "Cycle agent mode",
    handler: async (ctx) => cycleMode(ctx),
  });

  // ── Mode labels — show all 4 in footer ───────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    updateUI(ctx);
  });

  // ── Bash restriction in plan mode ─────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (state.mode !== "plan") return;
    // Non-interactive (subagent, json mode): skip restrictions
    if (!ctx.hasUI) return;

    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: `[Plan mode] Write/edit disabled. Switch to Edit mode (/mode edit) to make changes.`,
      };
    }

    if (event.toolName === "bash") {
      const cmd = event.input.command as string;
      if (!isBashSafe(cmd)) {
        return {
          block: true,
          reason: `[Plan mode] Destructive bash blocked: ${cmd.slice(0, 60)}...\nSwitch to Edit mode (/mode edit) to run.`,
        };
      }
    }
  });

  // ── Tool restriction in ask mode ──────────────────────────────────────

  pi.on("tool_call", async (event) => {
    if (state.mode !== "ask") return;
    return {
      block: true,
      reason: `[Ask mode] No tool calls allowed. Switch to Auto/Edit/Manual mode to use tools.`,
    };
  });

  // ── Manual mode: confirm every tool call ────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (state.mode !== "manual") return;
    if (!ctx.hasUI) {
      // Non-interactive (subagent, json mode, -p): inherit parent's trust, allow
      return;
    }

    const toolName = event.toolName;
    const args = event.input;

    // Build a short summary for confirm + allowlist key
    let summary: string;
    if (toolName === "bash") {
      const cmd = (args as { command?: string }).command ?? "?";
      summary = `bash: ${cmd.slice(0, 80)}`;
    } else if (toolName === "write" || toolName === "edit" || toolName === "read") {
      const path = (args as { path?: string }).path ?? "?";
      summary = `${toolName}: ${path}`;
    } else {
      summary = `${toolName}: ${JSON.stringify(args).slice(0, 80)}`;
    }

    // Check session allowlist
    if (manualAllowed.has(summary)) return;

    const choice = await ctx.ui.select(
      `👆 Manual mode — Allow ${toolName}?\n\n  ${summary}\n`,
      ["Yes (allow once)", "Always in this session", "No (block)"],
    );

    if (choice === "Yes (allow once)") return;
    if (choice === "Always in this session") {
      manualAllowed.add(summary);
      return;
    }
    return { block: true, reason: `[Manual mode] User declined: ${toolName}` };
  });

  // ── Context injection per mode ────────────────────────────────────────

  pi.on("before_agent_start", async () => {
    // Plan mode: if user sends message while plan is pending, auto-switch to edit
    if (state.mode === "plan" && state.planSteps.length > 0 && !state.executing) {
      state.mode = "edit";
      state.executing = true;
      state.failureCount = 0;
      restoreTools();
    }

    let context: string;
    switch (state.mode) {
      case "auto":   context = getAutoContext(); break;
      case "plan":   context = getPlanContext(); break;
      case "edit":   context = getEditContext(); break;
      case "manual": context = getManualContext(); break;
      case "ask":    return; // no injection needed
    }
    return {
      message: {
        customType: "modes-context",
        content: context,
        display: false,
      },
    };
  });

  // ── Clean context when not in modes ───────────────────────────────────

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((msg) => {
        const ctm = msg as { customType?: string };
        if (ctm.customType === "modes-context") return false;
        return true;
      }),
    };
  });

  // ── Auto mode: detect plan → prompt execution ─────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const msgs = event.messages as AgentMessage[];

    if (state.mode === "auto" || state.mode === "plan") {
      // Look for plan in last assistant response
      const lastAsst = [...msgs].reverse().find(
        (m) => "role" in m && (m as { role: string }).role === "assistant" && Array.isArray((m as { content: unknown }).content)
      ) as AssistantMessage | undefined;

      if (lastAsst) {
        const text = (lastAsst.content as TextContent[])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        const steps = extractSteps(text);

        if (steps.length > 0) {
          state.planSteps = steps;
          state.executing = false;
          state.failureCount = 0;
          updateUI(ctx);
          persist();

          if (state.mode === "auto") {
            // Auto-execute immediately, no confirmation
            state.executing = true;
            updateUI(ctx);
            persist();

            const remaining = state.planSteps.filter((s) => !s.completed);
            const list = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
            const first = remaining[0];
            pi.sendMessage(
              { customType: "modes-plan-summary", content: `**Plan (${steps.length} steps)** — auto-executing...`, display: true },
              { triggerTurn: false },
            );
            pi.sendUserMessage(
              `Execute the plan steps. Mark each with [DONE:n].\n\n${list}\n\nStart with step ${first?.step}: ${first?.text}`,
              { deliverAs: "followUp" },
            );
          } else {
            // Plan mode: show plan, then offer execute / refine / stay
            const stepsText = steps.map((s) => `${s.step}. ☐ ${s.text}`).join("\n");
            pi.sendMessage(
              { customType: "modes-plan-summary", content: `**Plan (${steps.length} steps)**\n\n${stepsText}`, display: true },
              { triggerTurn: false },
            );

            const choice = await ctx.ui.select(`📋 Plan ready (${steps.length} steps) — what next?`, [
              "Execute the plan",
              "Refine the plan",
              "Stay in plan mode",
            ]);

            if (choice === "Execute the plan") {
              state.mode = "edit";
              state.executing = true;
              state.failureCount = 0;
              restoreTools();
              updateUI(ctx);
              persist();

              const remaining = state.planSteps.filter((s) => !s.completed);
              const list = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
              const first = remaining[0];
              pi.sendUserMessage(
                `Execute the plan steps. Mark each with [DONE:n].\n\n${list}\n\nStart with step ${first?.step}: ${first?.text}`,
                { deliverAs: "followUp" },
              );
            } else if (choice === "Refine the plan") {
              const currentPlan = state.planSteps.map((s) => `${s.step}. ${s.text}`).join("\n");
              const refinement = await ctx.ui.editor("Refine the plan:", currentPlan);
              if (refinement?.trim()) {
                // Clear pending plan so the auto-switch (plan→edit) doesn't hijack the refinement turn
                state.planSteps = [];
                state.executing = false;
                updateUI(ctx);
                persist();
                pi.sendUserMessage(
                  `Here's my refined plan — analyze it and create an updated numbered plan under a "Plan:" header:\n\n${refinement.trim()}`,
                  { deliverAs: "followUp" },
                );
              }
            }
            // "Stay in plan mode" → nothing; plan stays pending
          }
        }
      }
    }

    // Detect plan completion
    if (state.executing && state.planSteps.length > 0) {
      if (state.planSteps.every((s) => s.completed)) {
        const done = state.planSteps.map((s) => `~~${s.text}~~`).join("\n");
        pi.sendMessage(
          { customType: "modes-done", content: `**✅ Plan Complete!**\n\n${done}`, display: true },
          { triggerTurn: false },
        );
        state.executing = false;
        state.planSteps = [];
        state.failureCount = 0;
        updateUI(ctx);
        persist();
      }
    }
  });

  // ── Track DONE markers ────────────────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    if (!state.executing || state.planSteps.length === 0) return;
    if (!("role" in event.message) || event.message.role !== "assistant") return;

    const text = (event.message as AssistantMessage).content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (markDone(text, state.planSteps) > 0) {
      state.failureCount = 0; // reset on success
      updateUI(ctx);
    }
    persist();
  });

  // ── Failure tracking ──────────────────────────────────────────────────

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!state.executing || !event.isError) return;
    state.failureCount++;
    state.lastError = event.toolName + ": " + (event.result?.content ?? "error");
    updateUI(ctx);
    persist();
    if (state.failureCount >= MAX_FAILURES) {
      ctx.ui.notify(`⚠ ${MAX_FAILURES} consecutive failures! Pausing.`, "error");
    }
  });

  // ── Session restore ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("mode");
    if (flag && MODES.includes(flag as AgentMode)) {
      state.mode = flag as AgentMode;
      if (flag === "plan" || flag === "ask") restrictTools();
    }

    // Restore persisted state
    const entries = ctx.sessionManager.getEntries();
    const saved = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "modes-state")
      .pop() as { data?: ModeState } | undefined;

    if (saved?.data) {
      const d = saved.data;
      state.mode = d.mode ?? state.mode;
      state.planSteps = d.planSteps ?? state.planSteps;
      state.executing = d.executing ?? state.executing;
      state.failureCount = d.failureCount ?? state.failureCount;
      state.lastError = d.lastError ?? state.lastError;

      // Re-scan for DONE markers — only messages after the current plan was created,
      // so [DONE:n] markers from earlier plans don't leak into this one.
      if (state.executing && state.planSteps.length > 0) {
        let markerIndex = -1;
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i] as { type: string; customType?: string };
          if (entry.type === "custom" && entry.customType === "modes-plan-summary") {
            markerIndex = i;
            break;
          }
        }

        const msgs = entries
          .slice(markerIndex + 1)
          .filter((e) => e.type === "message" && "message" in e)
          .map((e) => (e as { message: AgentMessage }).message)
          .filter((m) => m.role === "assistant" && Array.isArray(m.content));
        const allText = msgs
          .map((m) => (m as AssistantMessage).content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n"))
          .join("\n");
        markDone(allText, state.planSteps);
      }

      if (state.mode === "plan" || state.mode === "ask") restrictTools();
    }

    updateUI(ctx);
  });
}
