import type { AuditorProgress } from "./goal-auditor.ts";
import { nowIso } from "./goal-record.ts";
import type { AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import type { AuditVerdict } from "./widgets/auditor-dashboard-model.ts";

export interface CompletionAudit {
	controller: AbortController;
	startedAt: number;
}

/** Completion-audit UI resources; construction registers no timers or other work. */
export class GoalAuditRuntime {
	progress: AuditorWidgetProgress | null = null;
	animationTimer: ReturnType<typeof setInterval> | null = null;
	controller: AbortController | null = null;
	result: { verdict: AuditVerdict; report: string; at: string } | null = null;
	aborted = false;
	private resultClearTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly invalidate: () => void;

	constructor(invalidate: () => void) { this.invalidate = invalidate; }

	start(auditorLabel: string): CompletionAudit {
		this.stopAnimation();
		this.controller?.abort();
		const audit = { controller: new AbortController(), startedAt: Date.now() };
		this.controller = audit.controller;
		this.progress = { recentOutput: [], phase: "running", elapsedMs: 0, auditorLabel };
		this.animationTimer = setInterval(() => {
			if (this.controller !== audit.controller) return;
			if (!this.progress) { this.stopAnimation(); return; }
			this.progress.elapsedMs = Date.now() - audit.startedAt;
			this.invalidate();
		}, 80);
		this.animationTimer.unref?.();
		return audit;
	}

	update(audit: CompletionAudit, progress: AuditorProgress): void {
		if (this.controller !== audit.controller) return;
		this.progress = { ...progress, elapsedMs: Date.now() - audit.startedAt };
		this.invalidate();
	}

	finish(audit: CompletionAudit, clearProgress: boolean): void {
		audit.controller.abort();
		if (this.controller !== audit.controller) return;
		this.controller = null;
		this.stopAnimation();
		if (clearProgress) this.progress = null;
	}

	stopAnimation(): void {
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = null;
	}

	/** Escape is an explicit user action, distinct from parent/session cancellation. */
	abortByUser(): void {
		if (!this.controller || !this.progress) return;
		this.controller.abort();
		this.controller = null;
		this.stopAnimation();
		this.progress = null;
		this.invalidate();
		this.aborted = true;
	}

	setResult(verdict: AuditVerdict, report: string): void {
		this.result = { verdict, report, at: nowIso() };
		if (this.resultClearTimer) clearTimeout(this.resultClearTimer);
		this.resultClearTimer = setTimeout(() => {
			this.result = null;
			this.resultClearTimer = null;
			this.invalidate();
		}, 6000);
		this.resultClearTimer.unref?.();
		this.invalidate();
	}

	clearResult(): void {
		if (this.resultClearTimer) clearTimeout(this.resultClearTimer);
		this.resultClearTimer = null;
		this.result = null;
	}

	shutdown(): void {
		this.controller?.abort();
		this.controller = null;
		this.stopAnimation();
		this.clearResult();
		this.progress = null;
	}
}
