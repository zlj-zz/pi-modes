# pi-modes — Mode switching for pi

Five agent modes inspired by Claude Code.

## Modes

| Mode | Icon | Behavior | Tools |
|------|------|----------|-------|
| **Auto** | 🔄 | Smart: simple tasks → do it; complex → plan first | All |
| **Plan** | 📋 | Read-only analysis, creates numbered plans | Read + bash (safe only) |
| **Edit** | ✏️ | Full access, no planning | All |
| **Manual** | 👆 | Full tools, confirms EACH tool call | All (with confirm) |
| **Ask** | 💬 | Pure Q&A, answers without tools | None |

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `/mode` | `Ctrl+Alt+M` | Cycle: auto → plan → edit → manual → ask |
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
3. If plan detected → prompt: "Execute?"
4. Confirmed → agent executes with `[DONE:n]` tracking

### Plan mode
1. All write/edit tools disabled
2. Bash restricted to read-only commands
3. Agent analyzes and creates a plan
4. User switches to Edit mode to execute

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
