import { randomUUID } from "node:crypto";
import type { AuditorProgress } from "./goal-auditor.ts";
import { nowIso } from "./goal-record.ts";
import type { AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import type { AuditVerdict } from "./widgets/auditor-dashboard-model.ts";

export interface CompletionAudit {
	id: string;
	controller: AbortController;
	startedAt: number;
}

/** Completion-audit UI resources; construction registers no timers or other work. */
export class GoalAuditRuntime {
	progress: AuditorWidgetProgress | null = null;
	animationTimer: ReturnType<typeof setInterval> | null = null;
	controller: AbortController | null = null;
	private activeAudit: CompletionAudit | null = null;
	result: { verdict: AuditVerdict; report: string; at: string } | null = null;
	aborted = false;
	private resultClearTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly invalidate: () => void;

	constructor(invalidate: () => void) { this.invalidate = invalidate; }

	start(auditorLabel: string): CompletionAudit {
		this.stopAnimation();
		this.activeAudit?.controller.abort();
		const audit = { id: randomUUID(), controller: new AbortController(), startedAt: Date.now() };
		this.activeAudit = audit;
		this.controller = audit.controller;
		this.aborted = false;
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

	isCurrent(audit: CompletionAudit): boolean {
		return this.activeAudit === audit;
	}

	update(audit: CompletionAudit, progress: AuditorProgress): void {
		if (!this.isCurrent(audit)) return;
		this.progress = { ...progress, elapsedMs: Date.now() - audit.startedAt };
		this.invalidate();
	}

	finish(audit: CompletionAudit, clearProgress: boolean): void {
		audit.controller.abort();
		if (!this.isCurrent(audit)) return;
		this.controller = null;
		this.stopAnimation();
		if (clearProgress) this.progress = null;
	}

	stopAnimation(): void {
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = null;
	}

	/** Retire an attempt replaced by a new request, including non-audited completion. */
	retire(): void {
		this.activeAudit?.controller.abort();
		this.activeAudit = null;
		this.controller = null;
		this.stopAnimation();
		this.progress = null;
		this.aborted = false;
		this.clearResult();
		this.invalidate();
	}

	/** Escape is an explicit user action, distinct from parent/session cancellation. */
	abortByUser(): void {
		if (!this.activeAudit || !this.controller || !this.progress) return;
		this.controller.abort();
		this.stopAnimation();
		this.progress = null;
		this.invalidate();
		this.aborted = true;
	}

	setResult(verdict: AuditVerdict, report: string): void {
		const result = { verdict, report, at: nowIso() };
		this.result = result;
		if (this.resultClearTimer) clearTimeout(this.resultClearTimer);
		this.resultClearTimer = setTimeout(() => {
			if (this.result !== result) return;
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
		this.activeAudit?.controller.abort();
		this.activeAudit = null;
		this.controller = null;
		this.stopAnimation();
		this.clearResult();
		this.progress = null;
	}
}
