import assert from "node:assert/strict";
import test from "node:test";

import { buildGoalAttentionNotification, buildGoalRunningNotification, notifyGoalNeedsUser } from "../extensions/widgets/goal-notifications.ts";
import { createMockExtensionContext } from "./tui-test-utils.ts";

// ── buildGoalRunningNotification unit tests ────────────────────────────

test("buildGoalRunningNotification shows Goal mode with auto-continue on", () => {
	const result = buildGoalRunningNotification({
		objective: "=== Goal ===\nObjective: 研究 pi-goal 的 compact 行为\nSuccess criteria: answer",
		sisyphus: false,
		autoContinue: true,
	});
	assert.equal(result, "● Goal running\n├─ ⟡ 研究 pi-goal 的 compact 行为\n└─ auto-continue on");
});

test("buildGoalRunningNotification shows Sisyphus mode with manual mode", () => {
	const result = buildGoalRunningNotification({
		objective: "=== Sisyphus Goal ===\nObjective: Ship safely",
		sisyphus: true,
		autoContinue: false,
	});
	assert.equal(result, "◆ Sisyphus running\n├─ ⟡ Ship safely\n└─ manual mode");
});

test("buildGoalRunningNotification handles empty objective", () => {
	const result = buildGoalRunningNotification({
		objective: "",
		sisyphus: false,
		autoContinue: true,
	});
	assert.match(result, /● Goal running/);
	assert.match(result, /├─ ⟡/);
	assert.match(result, /└─ auto-continue on/);
});

test("buildGoalRunningNotification handles very long objective title", () => {
	const longTitle = "A".repeat(200);
	const result = buildGoalRunningNotification({
		objective: `=== Goal ===\nObjective: ${longTitle}`,
		sisyphus: true,
		autoContinue: false,
	});
	// Title should be truncated to ~92 chars
	const titleLine = result.split("\n")[1];
	assert.ok(titleLine!.length < 120, "Long objective title is truncated");
});

test("buildGoalRunningNotification shows Goal mode with manual mode", () => {
	const result = buildGoalRunningNotification({
		objective: "=== Goal ===\nObjective: Fix bug\nSuccess criteria: done",
		sisyphus: false,
		autoContinue: false,
	});
	assert.match(result, /● Goal running/);
	assert.match(result, /├─ ⟡ Fix bug/);
	assert.match(result, /└─ manual mode/);
});

test("buildGoalRunningNotification shows Sisyphus mode with auto-continue on", () => {
	const result = buildGoalRunningNotification({
		objective: "=== Sisyphus Goal ===\nObjective: Research",
		sisyphus: true,
		autoContinue: true,
	});
	assert.match(result, /◆ Sisyphus running/);
	assert.match(result, /├─ ⟡ Research/);
	assert.match(result, /└─ auto-continue on/);
});

test("buildGoalRunningNotification handles multiline objective gracefully", () => {
	const result = buildGoalRunningNotification({
		objective: "=== Goal ===\nObjective: Task A\nStep 1: do x\nStep 2: do y",
		sisyphus: false,
		autoContinue: true,
	});
	// The displayObjectiveTitle should extract the first line or Objective line
	assert.match(result, /├─ ⟡/);
});

// ── TUI path: notification through ctx.ui.notify ───────────────────────

test("notification works through ctx.ui.notify with mocked TUI", async () => {
	const ctx = createMockExtensionContext();
	let lastNotifyMessage: string | undefined;
	let lastNotifyType: string | undefined;

	// Override notify to capture calls
	ctx.ui.notify = (message: string, type?: string) => {
		lastNotifyMessage = message;
		lastNotifyType = type;
	};

	const notification = buildGoalRunningNotification({
		objective: "=== Goal ===\nObjective: Test\nSuccess criteria: pass",
		sisyphus: true,
		autoContinue: false,
	});

	ctx.ui.notify(notification, "info");

	assert.equal(lastNotifyMessage, notification, "Notification message passed through");
	assert.equal(lastNotifyType, "info", "Notification type is info");
	assert.match(lastNotifyMessage ?? "", /◆ Sisyphus running/);
});

test("buildGoalRunningNotification produces consistent 3-line format", () => {
	const tests = [
		{ objective: "=== Goal ===\nObjective: A", sisyphus: false, autoContinue: true },
		{ objective: "=== Sisyphus Goal ===\nObjective: B", sisyphus: true, autoContinue: false },
		{ objective: "=== Goal ===\nObjective: C", sisyphus: false, autoContinue: false },
		{ objective: "=== Sisyphus Goal ===\nObjective: D", sisyphus: true, autoContinue: true },
	];

	for (const args of tests) {
		const result = buildGoalRunningNotification(args);
		const lines = result.split("\n");
		assert.equal(lines.length, 3, `3 lines for ${JSON.stringify(args)}`);
		assert.match(lines[0]!, /[●◆] (Goal|Sisyphus) running/);
		assert.match(lines[1]!, /├─ ⟡/);
		assert.match(lines[2]!, /└─ (auto-continue on|manual mode)/);
	}
});

// ── buildGoalAttentionNotification / notifyGoalNeedsUser ───────────────

test("a blocked goal announces the reason, what was tried, the fix and the commands", () => {
	const message = buildGoalAttentionNotification({
		objective: "=== Goal ===\nObjective: Finish the roadmap",
		status: "blocked",
		reason: "cargo test cannot link: CC/AR point to MinGW for an MSVC target",
		suggestedAction: "Unset CC and AR, or add .cargo/config.toml forcing MSVC tools, then /goal-resume",
		attempts: ["unset CC only", "clang-cl override", "rust-lld linker"],
	});
	assert.match(message, /^⛔ Goal blocked: Finish the roadmap$/m);
	assert.match(message, /^Why: cargo test cannot link/m);
	assert.match(message, /^Already tried: unset CC only; clang-cl override; rust-lld linker$/m);
	assert.match(message, /^To fix: Unset CC and AR/m);
	assert.match(message, /\/goal-resume .*\/goal-clear to abandon\./);
});

test("a paused goal announces without inventing missing fields", () => {
	const message = buildGoalAttentionNotification({ objective: "Ship it", status: "paused" });
	assert.match(message, /^⏸ Goal paused: Ship it$/m);
	assert.doesNotMatch(message, /Why:|Already tried:|To fix:/);
});

test("notifyGoalNeedsUser only fires for blocked and paused goals", () => {
	const seen: Array<{ message: string; type?: string }> = [];
	const ctx = { ui: { notify: (message: string, type?: "info" | "warning" | "error") => { seen.push({ message, type }); } } };
	const base = { id: "g", objective: "Do the thing", sisyphus: false, autoContinue: true, createdAt: "t", updatedAt: "t", usage: { tokensUsed: 0, activeSeconds: 0 } };
	notifyGoalNeedsUser(ctx, { ...base, status: "active" } as never);
	notifyGoalNeedsUser(ctx, { ...base, status: "complete" } as never);
	notifyGoalNeedsUser(ctx, null);
	assert.equal(seen.length, 0, "a running or finished goal needs nothing from the user");
	notifyGoalNeedsUser(ctx, { ...base, status: "blocked", pauseReason: "needs a decision", pauseSuggestedAction: "pick an exchange" } as never);
	notifyGoalNeedsUser(ctx, { ...base, status: "paused", pauseReason: "user paused" } as never);
	assert.deepEqual(seen.map((s) => s.type), ["warning", "info"]);
	assert.match(seen[0]!.message, /To fix: pick an exchange/);
});

test("a failing notification never breaks the transition", () => {
	const ctx = { ui: { notify: () => { throw new Error("no UI"); } } };
	notifyGoalNeedsUser(ctx, { id: "g", objective: "x", status: "blocked", sisyphus: false, autoContinue: true, createdAt: "t", updatedAt: "t", usage: { tokensUsed: 0, activeSeconds: 0 } } as never);
});
