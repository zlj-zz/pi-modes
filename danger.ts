/**
 * Danger Guard — safety net integrated into pi-modes
 *
 * Warns / confirms / blocks destructive bash commands and protected file writes.
 *
 * Danger levels:
 *   "warn"    — Show notification but allow
 *   "confirm" — Prompt for confirmation
 *   "block"   — Block without asking
 *
 * Mode integration (via getMode provider):
 *   - manual: confirm prompts are skipped (pi-modes already confirms every
 *     tool call); block and warn still apply
 *   - plan:   no prompts (pi-modes already blocks edit/write and destructive
 *     bash); block still applies as a final safety floor
 *   - auto/edit/ask: full behavior
 *
 * Tool call handlers are registered AFTER pi-modes' mode handlers, so plan
 * mode's block short-circuits before any prompt here, and manual mode's
 * "decline" also short-circuits (no double prompt). The only overlap left is
 * manual mode "allow" → this module skips its confirm prompt.
 *
 * Config file (optional, backward compatible with standalone pi-danger-guard):
 *   ~/.config/agent-hud/danger-guard.jsonc
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMode } from "./index.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

type DangerLevel = "warn" | "confirm" | "block";

interface PatternRule {
  pattern: string;      // regex pattern (string form for JSON)
  level: DangerLevel;
  description: string;  // human-readable explanation
}

interface GuardConfig {
  bashRules: PatternRule[];
  protectedPaths: { path: string; level: DangerLevel; description: string }[];
  sessionAllowlist: boolean;  // whether "allow in this session" is offered
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: GuardConfig = {
  sessionAllowlist: true,
  bashRules: [
    // ── Block (no question) ──────────────────────────────────────────
    { pattern: "rm\\s+(-rf?|--recursive)\\s+/",   level: "block", description: "Recursive delete from root" },
    { pattern: ">\\s*/dev/sd[a-z]",               level: "block", description: "Write to raw disk device" },
    { pattern: "mkfs\\.",                          level: "block", description: "Format filesystem" },
    { pattern: "dd\\s+if=.*of=/dev/",             level: "block", description: "Write to raw disk device" },
    { pattern: ":(){ :|:& };:",                    level: "block", description: "Fork bomb" },

    // ── Confirm (ask user) ───────────────────────────────────────────
    { pattern: "\\brm\\s+(-rf?|--recursive)",      level: "confirm", description: "Recursive delete" },
    { pattern: "\\brm\\s",                         level: "confirm", description: "Delete files" },
    { pattern: "\\bsudo\\b",                       level: "confirm", description: "Superuser command" },
    { pattern: "\\b(chmod|chown)\\b.*777",         level: "confirm", description: "World-writable permissions" },
    { pattern: "\\bchmod\\s+[uxg]?\\+[rwx]s",      level: "confirm", description: "Setuid/setgid bit change" },
    { pattern: "\\bchown\\s+(-R\\s+)?[^:]+:",       level: "confirm", description: "Change file ownership" },
    { pattern: "git\\s+push\\s+.*--force",          level: "confirm", description: "Force push to remote" },
    { pattern: "git\\s+reset\\s+--hard",            level: "confirm", description: "Hard reset (discard changes)" },
    { pattern: "git\\s+clean\\s+(-f|--force)",      level: "confirm", description: "Clean untracked files" },
    { pattern: "\\bdocker\\s+(rm|prune|system\\s+prune)", level: "confirm", description: "Remove Docker resources" },
    { pattern: "\\b(kill|pkill|killall)\\b",        level: "confirm", description: "Kill process" },
    { pattern: "\\bshutdown\\b",                    level: "confirm", description: "Shutdown system" },
    { pattern: "\\breboot\\b",                      level: "confirm", description: "Reboot system" },
    { pattern: "\\bnpm\\s+(unpublish|deprecate)",   level: "confirm", description: "Unpublish npm package" },
    { pattern: "\\b(cp|mv)\\s+.*\\/etc\\/",         level: "confirm", description: "Modify /etc directory" },
    { pattern: "\\bcurl\\s+.*\\|\\s*(ba)?sh",       level: "confirm", description: "Pipe curl to shell" },
    { pattern: "\\bwget\\s+.*\\|\\s*(ba)?sh",       level: "confirm", description: "Pipe wget to shell" },
    { pattern: "\\bchmod\\s+(-R\\s*)?[0-7]*7",      level: "confirm", description: "Make files executable/writable by all" },

    // ── Warn (notify but allow) ──────────────────────────────────────
    { pattern: "\\bnpm\\s+(install|uninstall|update)\\b", level: "warn", description: "Install/uninstall packages" },
    { pattern: "\\b(pip|pip3)\\s+install\\b",       level: "warn", description: "Install Python packages" },
    { pattern: "\\bbrew\\s+(install|uninstall)\\b",  level: "warn", description: "Install/uninstall Homebrew packages" },
    { pattern: "\\bgit\\s+rebase\\b",               level: "warn", description: "Git rebase" },
    { pattern: "\\bgit\\s+commit\\s+.*--amend",     level: "warn", description: "Amend last commit" },
  ],

  protectedPaths: [
    { path: ".env",             level: "block", description: "Environment variables (may contain secrets)" },
    { path: ".env.local",       level: "block", description: "Local environment variables" },
    { path: ".env.production",  level: "block", description: "Production environment variables" },
    { path: "node_modules/",    level: "confirm", description: "Node dependencies (use npm/yarn instead)" },
    { path: "package-lock.json",level: "confirm", description: "Package lock file" },
    { path: "yarn.lock",        level: "confirm", description: "Yarn lock file" },
    { path: "pnpm-lock.yaml",   level: "confirm", description: "pnpm lock file" },
    { path: ".git/",            level: "confirm", description: "Git internals" },
    { path: "credentials",      level: "block", description: "May contain credentials" },
    { path: "id_rsa",           level: "block", description: "SSH private key" },
    { path: "id_ed25519",       level: "block", description: "SSH private key" },
    { path: ".secrets",         level: "block", description: "Secrets file" },
    { path: "secrets.yml",      level: "block", description: "Secrets file" },
    { path: "config/master.key",level: "block", description: "Rails master key" },
  ],
};

// ─── Config loading ────────────────────────────────────────────────────────

function stripJsonc(src: string): string {
  const out: string[] = [];
  let i = 0;
  let state: "code" | "string" | "line" | "block" | "escape" = "code";
  while (i < src.length) {
    const c = src[i]!;
    const n1 = src[i + 1] ?? "";
    if (state === "code") {
      if (c === '"') { state = "string"; out.push(c); i++; }
      else if (c === "/" && n1 === "/") { state = "line"; i += 2; }
      else if (c === "/" && n1 === "*") { state = "block"; i += 2; }
      else { out.push(c); i++; }
    } else if (state === "line") {
      if (c === "\n") { state = "code"; out.push(c); }
      i++;
    } else if (state === "block") {
      if (c === "*" && n1 === "/") { state = "code"; i += 2; }
      else { if (c === "\n") out.push(c); i++; }
    } else if (state === "string") {
      out.push(c);
      if (c === "\\") state = "escape"; else if (c === '"') state = "code";
      i++;
    } else if (state === "escape") { out.push(c); state = "string"; i++; }
  }
  return out.join("");
}

function loadConfig(): GuardConfig {
  const home = homedir();
  const candidates = [
    process.env["DANGER_GUARD_CONFIG"],
    join(home, ".config", "agent-hud", "danger-guard.jsonc"),
    join(home, ".config", "agent-hud", "danger-guard.json"),
    join(home, ".agent-hud", "danger-guard.jsonc"),
    join(home, ".agent-hud", "danger-guard.json"),
  ].filter(Boolean);

  for (const path of candidates) {
    if (path && existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const obj = JSON.parse(stripJsonc(raw));
        return {
          sessionAllowlist: obj.sessionAllowlist ?? DEFAULT_CONFIG.sessionAllowlist,
          bashRules: obj.bashRules ?? DEFAULT_CONFIG.bashRules,
          protectedPaths: obj.protectedPaths ?? DEFAULT_CONFIG.protectedPaths,
        };
      } catch { /* ignore parse errors, use defaults */ }
    }
  }
  return DEFAULT_CONFIG;
}

// ─── Session allowlist ──────────────────────────────────────────────────────

const sessionAllowed: Map<string, Set<string>> = new Map();
// sessionAllowed.get("bash") → set of allowed command hashes
// sessionAllowed.get("path") → set of allowed paths

function hashCommand(cmd: string): string {
  // Simple hash for session dedup
  let h = 0;
  for (let i = 0; i < cmd.length; i++) {
    h = ((h << 5) - h + cmd.charCodeAt(i)) | 0;
  }
  return String(h);
}

// ─── Matching ───────────────────────────────────────────────────────────────

function matchBash(cmd: string, rules: PatternRule[]): PatternRule | null {
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern, "i").test(cmd)) return rule;
    } catch { /* skip invalid user regex */ }
  }
  return null;
}

function matchPath(filepath: string, rules: { path: string; level: DangerLevel; description: string }[]): { level: DangerLevel; description: string } | null {
  for (const rule of rules) {
    if (filepath.includes(rule.path)) {
      return { level: rule.level, description: rule.description };
    }
  }
  return null;
}

// ─── Notify/warn helpers ────────────────────────────────────────────────────

function levelIcon(level: DangerLevel): string {
  switch (level) {
    case "block": return "🚫";
    case "confirm": return "⚠️";
    case "warn": return "⚡";
  }
}

function levelLabel(level: DangerLevel): string {
  switch (level) {
    case "block": return "BLOCKED";
    case "confirm": return "CONFIRM";
    case "warn": return "WARNING";
  }
}

// ─── Extension ──────────────────────────────────────────────────────────────

export function initDangerGuard(pi: ExtensionAPI, getMode: () => AgentMode): void {
  const cfg = loadConfig();

  // ── Intercept bash tool calls ─────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    // Plan mode enforces its own bash allowlist — nothing to add here.
    if (getMode() === "plan") return;

    const command = event.input.command as string;
    if (!command || typeof command !== "string") return;

    const rule = matchBash(command, cfg.bashRules);
    if (!rule) return; // safe command

    const cmdHash = hashCommand(command);

    // Check session allowlist
    if (cfg.sessionAllowlist) {
      const bashSet = sessionAllowed.get("bash");
      if (bashSet?.has(cmdHash)) {
        ctx.ui.notify(`⚡ Allowed (session): ${rule.description}`, "info");
        return; // previously allowed in this session
      }
    }

    if (!ctx.hasUI) {
      // Non-interactive: block confirm and block levels, allow warn
      if (rule.level === "block" || rule.level === "confirm") {
        return {
          block: true,
          reason: `[danger-guard] ${levelLabel(rule.level)}: ${rule.description}\nCommand: ${command}`,
        };
      }
      // warn level: notify only (no blocking in non-interactive)
      return;
    }

    if (rule.level === "warn") {
      ctx.ui.notify(`${levelIcon("warn")} ${rule.description}: ${command.slice(0, 60)}...`, "warning");
      return; // allow, just notify
    }

    if (rule.level === "block") {
      ctx.ui.notify(`${levelIcon("block")} BLOCKED: ${rule.description}`, "error");
      return { block: true, reason: `[danger-guard] Blocked: ${rule.description}\nCommand: ${command}` };
    }

    // level === "confirm": ask user — but not in manual mode, which already
    // confirms every tool call (manual's "decline" short-circuits before us,
    // so we only ever run after the user allowed).
    if (getMode() === "manual") return;

    const truncatedCmd = command.length > 200 ? command.slice(0, 197) + "..." : command;

    const choices: string[] = ["No (block)", "Yes (allow once)"];
    if (cfg.sessionAllowlist) {
      choices.push("Always allow in this session");
    }

    const choice = await ctx.ui.select(
      `${levelIcon("confirm")} Dangerous command — ${rule.description}\n\n  $ ${truncatedCmd}\n\nAllow?`,
      choices,
    );

    if (choice === "Yes (allow once)") {
      ctx.ui.notify("⚡ Allowed (one-time)", "info");
      return;
    }

    if (choice === "Always allow in this session") {
      if (!sessionAllowed.has("bash")) sessionAllowed.set("bash", new Set());
      sessionAllowed.get("bash")!.add(cmdHash);
      ctx.ui.notify("⚡ Allowed (session)", "info");
      return;
    }

    return { block: true, reason: `[danger-guard] User declined: ${rule.description}` };
  });

  // ── Intercept write/edit tool calls ───────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    // Plan mode blocks all write/edit — nothing to add here.
    if (getMode() === "plan") return;

    const path = event.input.path as string;
    if (!path || typeof path !== "string") return;

    const match = matchPath(path, cfg.protectedPaths);
    if (!match) return;

    // Check session allowlist
    if (cfg.sessionAllowlist) {
      const pathSet = sessionAllowed.get("path");
      if (pathSet?.has(path)) {
        ctx.ui.notify(`⚡ Allowed (session): ${match.description}`, "info");
        return;
      }
    }

    if (!ctx.hasUI) {
      if (match.level === "block" || match.level === "confirm") {
        return {
          block: true,
          reason: `[danger-guard] ${levelLabel(match.level)}: ${match.description}\nPath: ${path}`,
        };
      }
      return;
    }

    if (match.level === "warn") {
      ctx.ui.notify(`${levelIcon("warn")} Writing to ${path} (${match.description})`, "warning");
      return;
    }

    if (match.level === "block") {
      ctx.ui.notify(`${levelIcon("block")} BLOCKED: ${match.description} — ${path}`, "error");
      return { block: true, reason: `[danger-guard] Blocked: ${match.description}\nPath: ${path}` };
    }

    // confirm — skipped in manual mode (see bash handler above)
    if (getMode() === "manual") return;

    const choices: string[] = ["No (block)", "Yes (allow once)"];
    if (cfg.sessionAllowlist) {
      choices.push("Always allow in this session");
    }

    const choice = await ctx.ui.select(
      `${levelIcon("confirm")} Protected path — ${match.description}\n\n  Path: ${path}\n\nAllow?`,
      choices,
    );

    if (choice === "Yes (allow once)") {
      ctx.ui.notify("⚡ Allowed (one-time)", "info");
      return;
    }

    if (choice === "Always allow in this session") {
      if (!sessionAllowed.has("path")) sessionAllowed.set("path", new Set());
      sessionAllowed.get("path")!.add(path);
      ctx.ui.notify("⚡ Allowed (session)", "info");
      return;
    }

    return { block: true, reason: `[danger-guard] User declined: ${match.description}` };
  });

  // ── Status in footer ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      "danger-guard",
      theme.fg("dim", `🛡 Guard: ${cfg.bashRules.length} bash rules, ${cfg.protectedPaths.length} paths`),
    );
  });
}
