# pi-modes — Mode switching for pi

Five agent modes inspired by Claude Code.

## Modes

| Mode | Icon | Behavior | Tools |
|------|------|----------|-------|
| **Manual** | ⊘ | Full tools, confirms EACH tool call | All (with confirm) |
| **Edit** | ✎ | Full access, no planning | All |
| **Plan** | ☷ | Read-only analysis, creates numbered plans | Read + bash (safe only) |
| **Auto** | ↻ | Smart: simple tasks → do it; complex → plan first | All |
| **Ask** | ? | Pure Q&A, answers without tools | None |

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `/mode` | `Ctrl+Alt+M` | Cycle: manual → edit → plan → auto → ask |
| `/mode auto` | — | Switch to Auto |
| `/mode plan` | — | Switch to Plan |
| `/mode edit` | — | Switch to Edit |
| `/mode manual` | — | Switch to Manual |
| `/mode ask` | — | Switch to Ask |
| `/auto` `/plan` `/edit` `/manual` `/ask` | — | Convenience sub-commands |

## How it works

### Auto mode (default)
1. User asks something
2. Agent decides:
   - Simple? → Just do it
   - Complex? → Creates a numbered plan under "Plan:" header
3. The agent outputs a numbered plan under `Plan:` header and prompts: **Execute / Refine / Stay**
4. Confirmed → agent executes with `[DONE:n]` tracking

### Plan mode
1. All write/edit tools disabled
2. Bash restricted to read-only commands; `questionnaire` tool added for clarifying questions (if installed)
3. Agent analyzes and creates a plan, then prompts:
   - **Execute the plan** → switches to Edit mode and starts execution
   - **Refine the plan** → opens editor to adjust steps, agent re-plans
   - **Stay in plan mode** → plan stays pending

### Edit mode
1. Full tools available
2. No planning overhead
3. Agent jumps straight into action

### Manual mode
1. All tools available
2. Before EACH tool call → confirm dialog appears
3. Options: Allow once / Always in this session / Block
4. Allowlist resets on mode switch
1. All tool calls blocked
2. Agent answers from knowledge only
3. Fast, no tool overhead

## Install

```bash
pi install git:github.com/zlj-zz/pi-modes
```

Or from local:

```bash
pi install ../pi-modes
```

## Safety Guard (built-in)

pi-modes ships with the danger guard formerly published as `pi-danger-guard` — an always-on safety net that works alongside the modes:

| Level | Bash | File |
|-------|------|------|
| **warn** | ⚡ Notify but allow | ⚡ Notify but allow |
| **confirm** | ⚠️ Prompt for confirmation | ⚠️ Prompt for confirmation |
| **block** | 🚫 Block immediately | 🚫 Block immediately |

- **Block**: `rm -rf /`, raw disk writes, format filesystems, fork bombs, `.env*`, SSH keys, credentials files
- **Confirm**: `rm`, `sudo`, `chmod 777`, `git push --force`, `git reset --hard`, `curl | sh`, `kill`, lock files, `.git/`
- **Warn**: `npm install`, `pip install`, `brew install`, `git rebase`

### Mode integration

- **manual** — confirm prompts skipped (pi-modes already confirms every tool call); block/warn still apply
- **plan** — no prompts (plan mode already blocks edit/write and destructive bash); block still applies
- **auto / edit / ask** — full guard behavior

### Config

Override defaults with `~/.config/agent-hud/danger-guard.jsonc` (path kept for backward compatibility with `pi-danger-guard`):

```jsonc
{
  "sessionAllowlist": true,
  "bashRules": [
    // add custom rules
  ],
  "protectedPaths": [
    // add custom paths
  ]
}
```
