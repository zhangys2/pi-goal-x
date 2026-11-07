import { mutateSettingsLayer } from "./goal-settings.ts";

export type GoalPreset = "lightweight" | "structured" | "audited";

export const GOAL_PRESETS: Record<GoalPreset, { title: string; settings: { disableTasks: boolean; disableContracts: boolean; defaultAuditorEnabled: boolean } }> = {
	lightweight: { title: "Lightweight", settings: { disableTasks: true, disableContracts: true, defaultAuditorEnabled: false } },
	structured: { title: "Structured", settings: { disableTasks: false, disableContracts: false, defaultAuditorEnabled: false } },
	audited: { title: "Audited", settings: { disableTasks: false, disableContracts: false, defaultAuditorEnabled: true } },
};

/** Apply only preset-owned keys to project settings; leave global and unrelated values untouched. */
export function applyGoalPreset(cwd: string, preset: GoalPreset): void {
	const settings = GOAL_PRESETS[preset].settings;
	mutateSettingsLayer({
		scope: "project",
		cwd,
		mutation: { op: "batch", mutations: Object.entries(settings).map(([key, value]) => ({ op: "set" as const, path: [key], value })) },
	});
}
