/** Compose caller, active-turn, and user-owned cancellation without listeners to clean up. */
export function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
	const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	return present.length > 1 ? AbortSignal.any(present) : present[0];
}
