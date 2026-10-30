const DEFAULT_KEEPALIVE_HOURS = 6;
const MIN_KEEPALIVE_HOURS = 1;
const MAX_KEEPALIVE_HOURS = 24;

// S_ETUKORTTI_KEEPALIVE_HOURS is user-editable; garbage falls back to the
// default and out-of-range values are clamped rather than rejected.
export function resolveKeepaliveHours(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_KEEPALIVE_HOURS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_KEEPALIVE_HOURS;
	return Math.min(MAX_KEEPALIVE_HOURS, Math.max(MIN_KEEPALIVE_HOURS, parsed));
}
