import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_COMMANDS, commandRoutes, matchCommandRoute } from "../extensions/goal-controls.ts";

const DEFAULT_PATHS: Record<string, string> = {
	goal: "gx",
	sisyphus: "gx sisyphus",
	"goal-direct": "gx direct",
	"sisyphus-direct": "gx sisyphus direct",
	"goal-tweak": "gx tweak",
	"goal-pause": "gx pause",
	"goal-resume": "gx resume",
	"goal-clear": "gx clear",
	"goal-list": "gx list",
	"goal-status": "gx status",
	"goal-refresh": "gx refresh",
	"goal-recovery": "gx recovery",
	"goal-focus": "gx focus",
	"goal-unfocus": "gx unfocus",
	"goal-settings": "gx settings",
	"goal-cancel": "gx cancel",
	"goal-report": "gx report",
	"goal-onboarding": "gx onboarding",
};

test("default goal-x actions share the /gx root and expose no legacy roots", () => {
	const routes = commandRoutes(undefined);
	const paths = Object.fromEntries(routes.map(({ id, path }) => [id, path]));
	assert.deepEqual(paths, DEFAULT_PATHS);
	assert.equal(GOAL_COMMANDS.length, Object.keys(DEFAULT_PATHS).length);
	assert.ok(routes.every(({ path }) => path === "gx" || path.startsWith("gx ")));
});

test("gx subcommands preserve action arguments and nested command arguments", () => {
	const routes = commandRoutes(undefined);
	assert.deepEqual(matchCommandRoute(routes, "gx", "status verbose"), { id: "goal-status", args: "verbose" });
	assert.deepEqual(matchCommandRoute(routes, "gx", "recovery repair"), { id: "goal-recovery", args: "repair" });
	assert.deepEqual(matchCommandRoute(routes, "gx", "list recovery"), { id: "goal-list", args: "recovery" });
	assert.deepEqual(matchCommandRoute(routes, "gx", "direct  Keep  spacing"), { id: "goal-direct", args: "Keep  spacing" });
	assert.deepEqual(matchCommandRoute(routes, "gx", "sisyphus direct Ordered steps"), { id: "sisyphus-direct", args: "Ordered steps" });
	assert.deepEqual(matchCommandRoute(routes, "gx", "settings controls"), { id: "goal-settings", args: "controls" });
});
