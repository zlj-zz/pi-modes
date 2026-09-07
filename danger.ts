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
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
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

// ─── Agent-file protection ─────────────────────────────────────────────────

// Absolute paths the agent wrote/edited this session (recorded in the
// write/edit tool handler below). A pattern rule matches text, not targets,
// so a config-demoted `rm` (warn) would silently delete the very files the
// agent itself created — this closes that gap.
const agentFiles: Set<string> = new Set();
const AGENT_FILES_MAX = 10_000; // ponytail: long-lived sessions cap the set (~1MB); drops oldest (insertion-ordered) first
function rememberAgentFile(p: string): void {
  agentFiles.add(p);
  if (agentFiles.size > AGENT_FILES_MAX) agentFiles.delete(agentFiles.keys().next().value!);
}

const WRAPPERS = new Set(["sudo", "command", "env", "doas"]);

// Split a shell command into tokens, honoring single/double quotes.
function shellTokens(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

// Locate the actual tool after wrappers (sudo/env/command/doas), their flags
// and VAR= assignments. Returns lowercase base name + remaining args.
// ponytail: only -u/--user consume a following value; other value-taking
// sudo flags are rare in agent rm/kill usage and not enumerated.
function toolAndRest(command: string): { tool?: string; rest: string[] } {
  const toks = shellTokens(command);
  let i = 0;
  while (i < toks.length) {
    const t = toks[i]!;
    if (WRAPPERS.has(t)) { i++; continue; }
    if (t.startsWith("-")) { i += ["-u", "--user"].includes(t) ? 2 : 1; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    break;
  }
  if (i >= toks.length) return {};
  return { tool: toks[i]!.toLowerCase().split("/").pop(), rest: toks.slice(i + 1) };
}

// Agent files living under (or equal to) one of the given rm/git targets.
function overlappingTargets(targets: string[], cwd: string, files: Set<string>): string[] {
  const hits: string[] = [];
  for (const raw of targets) {
    if (raw.startsWith("-")) continue; // flag, not a path
    const base = raw.split(/[*?[\]{}]/)[0]!; // drop from first wildcard on
    const target = isAbsolute(base) ? base : resolve(cwd, base || ".");
    const prefix = target.endsWith(sep) ? target : target + sep;
    for (const f of files) {
      if ((f === target || f.startsWith(prefix)) && !hits.includes(f)) {
        hits.push(f);
        if (hits.length === 3) return hits;
      }
    }
  }
  return hits;
}

/**
 * Pure check: would `command` destroy files the agent touched this session?
 * Escalates `rm` / `git checkout` / `git restore` with overlapping paths and
 * `git clean -f` (deletes the agent's untracked new files). Returns a
 * human-readable reason, or null when not a threat. Exported for the test.
 *
 * ponytail: `git reset --hard` is deliberately NOT escalated — it only
 * discards tracked changes and is already confirm-level by default; demoting
 * it in config is an explicit opt-out.
 */
export function agentFileThreat(command: string, cwd: string, files: Set<string>): string | null {
  if (files.size === 0) return null;
  const cmd = toolAndRest(command);
  if (!cmd?.tool) return null;
  const { tool, rest } = cmd;

  if (tool === "git") {
    const sub = rest[0];
    if (!sub) return null;
    if (sub === "clean") {
      if (rest.slice(1).some((f) => f === "--force" || /^-[a-z]*f/.test(f))) {
        return "git clean -f would delete untracked files created/modified this session";
      }
      return null;
    }
    if (sub === "rm") {
      const hits = overlappingTargets(rest.slice(1).filter((t) => !t.startsWith("-")), cwd, files);
      if (hits.length > 0) {
        return `git rm would delete file(s) created/modified this session: ${hits.join(", ")}`;
      }
      return null;
    }
    if (sub === "checkout" || sub === "restore") {
      const args = rest.slice(1);
      const dd = args.indexOf("--");
      const paths = dd >= 0 ? args.slice(dd + 1) : args.filter((t) => !t.startsWith("-"));
      const hits = overlappingTargets(paths, cwd, files);
      if (hits.length > 0) {
        return `git ${sub} would discard file(s) modified this session: ${hits.join(", ")}`;
      }
    }
    return null;
  }

  if (tool === "rm") {
    const hits = overlappingTargets(rest, cwd, files);
    if (hits.length > 0) {
      return `rm would delete file(s) created/modified this session: ${hits.join(", ")}`;
    }
  }
  return null;
}

// ─── Kill protection ────────────────────────────────────────────────────────
// The rm layer protects the agent's own files; kill inverts it — signalling a
// process the agent spawned this session is routine cleanup (restart your own
// dev server), while killing anything else still prompts.

/**
 * Pure decision for kill-family commands. Returns:
 *   { allow: true }   — safe (agent's own processes / probes / %jobs) → silent
 *   { prompt: "..." } — needs confirmation
 *   undefined         — not a kill command
 * Exported for tests (tests/danger-guard.test.ts).
 */
export function killDecision(
  command: string,
  isOwn: (pid: number) => boolean,
): { allow: true } | { prompt: string } | undefined {
  const cmd = toolAndRest(command);
  if (!cmd?.tool) return undefined;
  const { tool, rest } = cmd;
  if (tool !== "kill" && tool !== "pkill" && tool !== "killall") return undefined;

  if (tool === "pkill" || tool === "killall") {
    return { prompt: `${tool} matches by name — confirm it only hits processes this session started` };
  }
  if (rest.includes("-0") || rest.includes("-l")) return { allow: true }; // probe/list, sends no signal
  // Compound shell command — approving only the kill part would rubber-stamp
  // whatever follows (; && || |). Fall through to the static rules instead.
  if (rest.some((t) => /[;&|]/.test(t))) return undefined;
  if (rest.some((t) => /[`$]/.test(t) || t.startsWith("("))) {
    return { prompt: "kill target is a shell expression — can't verify it only hits this session's processes" };
  }

  // Separate an optional leading signal spec (-9, -TERM, -s HUP) from targets.
  let targets = rest;
  if (rest.length > 1) {
    const s = rest[0]!;
    if (s === "-s" || s === "--signal" || s === "-n") targets = rest.slice(2);
    else if (s.startsWith("-") && !s.startsWith("--")) targets = rest.slice(1);
  }

  // Any negative number in target position is a pid with a minus sign:
  // -1 = every process, -PGID = whole group. Never silently allowed.
  const neg = targets.filter((t) => /^-\d+$/.test(t));
  if (neg.length > 0) {
    return { prompt: `kill targets ${neg.join(", ")} — negative pid means a process group or all processes (-1)` };
  }
  const pids = targets.filter((t) => /^[1-9]\d*$/.test(t)).map(Number);
  const junk = targets.filter((t) => !/^\d+$/.test(t) && !t.startsWith("%"));
  if (junk.length > 0) {
    return { prompt: `kill target ${junk[0]} can't be verified as this session's process` };
  }
  const foreign = pids.filter((p) => !isOwn(p));
  if (foreign.length > 0) {
    return { prompt: `kill would signal PID ${foreign.join(", ")} — not started by this session` };
  }
  return { allow: true }; // own pids, %jobs, kill 0 (own group)
}

// Is `pid` one of the processes the agent spawned this session? Walks the
// ppid chain up to the pi agent process (children of pi → own) and returns
// false the moment it hits pi itself (killing the agent must never be
// silently allowed).
// ponytail: a daemon that double-forks away from pi's tree re-parents to init
// and won't match — such kills prompt (safe default, never silent).
function isAgentDescendant(pid: number): boolean {
  let cur = pid;
  for (let i = 0; i < 16 && cur > 1; i++) {
    if (cur === process.pid) return pid !== process.pid;
    let out: string;
    try {
      out = execSync(`ps -o ppid= -p ${cur}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return false;
    }
    const next = Number(out);
    if (!Number.isInteger(next) || next <= 0) return false;
    cur = next;
  }
  return false;
}

// Blank out heredoc bodies (<<EOF … EOF). Their content is stdin data, never
// executed by the shell — but text rules match the raw string, so a commit
// message mentioning "rm" would otherwise trip the delete rule.
// ponytail: inline quoted strings are NOT masked here — `bash -c "rm -rf x"`
// executes its quoted arg, so masking those would hide real danger.
export function stripHeredocs(cmd: string): string {
  let delim: string | null = null;
  return cmd
    .split("\n")
    .map((ln) => {
      if (delim) {
        if (ln.trim() === delim) delim = null;
        return "";
      }
      const m = /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(ln);
      if (m) delim = m[1] ?? m[2] ?? m[3]!;
      return ln;
    })
    .join("\n");
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

    // Agent-file protection — static rules match patterns, not targets, so a
    // config-demoted `rm` (warn) would silently delete files the agent itself
    // wrote/edited this session. Escalate those to a real prompt — unless the
    // configured rule already hard-blocks (rm -rf / must stay a silent block,
    // never a dialog that could be mis-clicked past).
    const staticRule = matchBash(stripHeredocs(command), cfg.bashRules);
    const hardBlocked = staticRule !== null && staticRule.level === "block";
    if (!hardBlocked) {
      // kill family: signalling a process the agent itself spawned is routine
      // cleanup — allow silently. Unowned PIDs, pkill/killall, process groups
      // and shell-expanded targets (kill $PID) get the prompt treatment too.
      const kill = killDecision(command, isAgentDescendant);
      if (kill?.allow) return;
      const threat = kill?.prompt ?? agentFileThreat(command, ctx.cwd, agentFiles);
      if (threat) {
        if (cfg.sessionAllowlist && sessionAllowed.get("bash")?.has(hashCommand(command))) {
          ctx.ui.notify(`⚡ Allowed (session): ${threat}`, "info");
          return;
        }
        if (!ctx.hasUI) {
          return { block: true, reason: `[danger-guard] ${threat}\nCommand: ${command}` };
        }
        if (getMode() === "manual") return; // manual mode confirms every tool call already

        const choices: string[] = ["No (block)", "Yes (allow once)"];
        if (cfg.sessionAllowlist) choices.push("Always allow in this session");
        const choice = await ctx.ui.select(
          `⚠️ ${threat}\n\n  $ ${command.slice(0, 200)}\n\nAllow?`,
          choices,
        );
        if (choice === "Yes (allow once)" || choice === "Always allow in this session") {
          if (choice === "Always allow in this session") {
            if (!sessionAllowed.has("bash")) sessionAllowed.set("bash", new Set());
            sessionAllowed.get("bash")!.add(hashCommand(command));
          }
          ctx.ui.notify("⚡ Allowed", "info");
          return;
        }
        return { block: true, reason: `[danger-guard] Declined: ${threat}` };
      }
    }

    const rule = staticRule;
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

    // Remember every file the agent writes/edits this session — the bash guard
    // above escalates rm/git commands that would destroy them.
    rememberAgentFile(resolve(ctx.cwd, path));

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
