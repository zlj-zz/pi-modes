// Agent-file protection checks for danger.ts — run: npm test
import { strict as assert } from "node:assert";
import { agentFileThreat, killDecision } from "../danger.ts";

const cwd = "/repo";
const files = new Set(["/repo/src/a.ts", "/repo/newfile.txt", "/repo/my file.ts"]);

// ── rm of the agent's own files ──
assert.match(agentFileThreat("rm src/a.ts", cwd, files)!, /a\.ts/);
assert.match(agentFileThreat("rm -rf src", cwd, files)!, /a\.ts/); // dir prefix
assert.match(agentFileThreat("rm -rf src/*.ts", cwd, files)!, /a\.ts/); // wildcard
assert.match(agentFileThreat('rm "my file.ts"', cwd, files)!, /my file/); // quoted space
assert.match(agentFileThreat("sudo rm src/a.ts", cwd, files)!, /a\.ts/); // wrapper

// rm of files the agent did NOT touch → no threat
assert.equal(agentFileThreat("rm dist/bundle.js", cwd, files), null);
assert.equal(agentFileThreat("rm -rf /etc/apt", cwd, files), null);

// ── git commands that discard agent work ──
assert.match(agentFileThreat("git checkout -- src/a.ts", cwd, files)!, /discard/);
assert.match(agentFileThreat("git checkout HEAD -- src", cwd, files)!, /discard/); // dir after --
assert.match(agentFileThreat("git checkout .", cwd, files)!, /discard/);
assert.match(agentFileThreat("git restore src/a.ts", cwd, files)!, /discard/);
assert.match(agentFileThreat("git clean -fd", cwd, files)!, /untracked/);
assert.match(agentFileThreat("git clean -f", cwd, files)!, /untracked/);

// git ops that don't destroy agent files → no threat
assert.equal(agentFileThreat("git checkout main", cwd, files), null);
assert.equal(agentFileThreat("git status", cwd, files), null);
assert.equal(agentFileThreat("git commit -am x", cwd, files), null);

// ── unrelated commands → null ──
assert.equal(agentFileThreat("ls src", cwd, files), null);
assert.equal(agentFileThreat("kill 123", cwd, files), null);
assert.equal(agentFileThreat("curl -s example.com", cwd, files), null);

// ── no agent files tracked → never a threat ──
assert.equal(agentFileThreat("rm src/a.ts", cwd, new Set()), null);

// ── kill: agent's own processes are cleanup → allow; anything else → prompt ──
const own = new Set([1000, 2000]);
const isOwn = (p: number) => own.has(p);

assert.deepEqual(killDecision("kill 1000", isOwn), { allow: true });
assert.deepEqual(killDecision("kill -9 2000", isOwn), { allow: true });
assert.deepEqual(killDecision("sudo kill 1000", isOwn), { allow: true }); // wrapper
assert.deepEqual(killDecision("kill -TERM 1000", isOwn), { allow: true }); // named signal
assert.deepEqual(killDecision("kill %1", isOwn), { allow: true }); // shell job
assert.deepEqual(killDecision("kill -0 999", isOwn), { allow: true }); // probe, no signal
assert.deepEqual(killDecision("kill -l", isOwn), { allow: true }); // list signals
assert.deepEqual(killDecision("kill 0", isOwn), { allow: true }); // own group

assert.match(killDecision("kill 999", isOwn)!.prompt!, /999/);
assert.match(killDecision("kill -9 999", isOwn)!.prompt!, /999/);
assert.match(killDecision("kill 1000 999", isOwn)!.prompt!, /999/);
assert.match(killDecision("kill $PID", isOwn)!.prompt!, /expression/);
assert.match(killDecision("kill $(cat /tmp/x)", isOwn)!.prompt!, /expression/);
assert.match(killDecision("kill -1234", isOwn)!.prompt!, /group/);
assert.match(killDecision("pkill node", isOwn)!.prompt!, /by name/);
assert.match(killDecision("killall beam.smp", isOwn)!.prompt!, /by name/);

// not kill commands
assert.equal(killDecision("ls", isOwn), undefined);
assert.equal(killDecision("rm src/a.ts", isOwn), undefined);
assert.equal(killDecision("ps aux | grep node", isOwn), undefined);

// ── review regressions ──
// negative pid in target position (-1 = all processes) must NEVER be silent
assert.ok(!killDecision("kill -9 -1", isOwn)!.allow);
assert.match(killDecision("kill -9 -1", isOwn)!.prompt!, /all processes/);
assert.match(killDecision("kill -s HUP -1", isOwn)!.prompt!, /negative pid/);
assert.match(killDecision("kill -- -1", isOwn)!.prompt!, /negative pid/);
assert.match(killDecision("kill -1234", isOwn)!.prompt!, /group/);
assert.match(killDecision("kill 999 -1", isOwn)!.prompt!, /negative pid/);

// compound commands fall through to static rules (own-pid allow must not
// rubber-stamp a trailing destructive segment)
assert.equal(killDecision("kill 1000 && rm -rf src", isOwn), undefined);
assert.equal(killDecision("kill 1000; git clean -f", isOwn), undefined);

// wrapper with flags, case variants, git rm
assert.match(agentFileThreat("sudo -u root rm src/a.ts", cwd, files)!, /a\.ts/);
assert.match(agentFileThreat("env FOO=1 rm src/a.ts", cwd, files)!, /a\.ts/);
assert.match(agentFileThreat("RM -rf src", cwd, files)!, /a\.ts/);
assert.match(agentFileThreat("GIT checkout -- src/a.ts", cwd, files)!, /discard/);
assert.match(agentFileThreat("git rm src/a.ts", cwd, files)!, /a\.ts/);

console.log("danger-guard agent-file checks: OK");
