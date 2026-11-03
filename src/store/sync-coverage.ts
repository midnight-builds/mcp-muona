// The last day up to which the local receipt history is known to be complete.
// Syncs without explicit dates start from it, so a routine sync asks
// S-Etukortti only for the days that can still change instead of re-reading
// weeks it already has. Kept in the settings table because it must survive
// restarts: an in-memory value would send every restart back to the fallback.

import * as z from "zod/v4";
import { shiftDate } from "../date-range.ts";
import { logger } from "../logger.ts";
import { getSetting, setSetting } from "./settings.ts";

export const SYNC_COVERAGE_SETTING_KEY = "sync.coverage";

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SyncCoverageSchema = z.object({ through: IsoDateSchema, at: z.iso.datetime() });

export type SyncCoverage = z.infer<typeof SyncCoverageSchema>;

export function getSyncCoverage(): SyncCoverage | null {
	try {
		const raw = getSetting(SYNC_COVERAGE_SETTING_KEY);
		if (raw === null) return null;
		const parsed = SyncCoverageSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch (err) {
		logger.warn({ err }, "Could not read the receipt sync coverage");
		return null;
	}
}

// Coverage only grows over contiguous ranges: a sync starting after the
// covered day plus one would leave unsynced days behind it. `at` records the
// last such success even when the day does not move; auto-sync reads it as
// proof that the session works again. Without coverage,
// only a sync that reaches today starts it, since an old backfill says nothing
// about recent weeks. Best-effort: a broken settings DB must not fail a sync
// that already stored its receipts.
export function recordSyncedRange(
	range: { startDate: string; endDate: string },
	today: string,
	now: Date,
): void {
	try {
		const end = range.endDate < today ? range.endDate : today;
		const current = getSyncCoverage();
		if (current === null) {
			if (end !== today) return;
		} else if (range.startDate > shiftDate(current.through, 1)) {
			return;
		}
		const through = current !== null && current.through > end ? current.through : end;
		setSetting(SYNC_COVERAGE_SETTING_KEY, JSON.stringify({ through, at: now.toISOString() }));
		if (current?.through !== through) {
			logger.info(
				{ through, previous: current?.through ?? null },
				"Receipt sync coverage advanced",
			);
		}
	} catch (err) {
		logger.warn({ err }, "Could not record the receipt sync coverage");
	}
}

// Starts a day before the covered day so that a receipt posted around
// midnight, or late, is still picked up; without coverage, from `fallbackStart`.
export function incrementalSyncRange(
	today: string,
	fallbackStart: string,
): { startDate: string; endDate: string; basis: "coverage" | "fallback" } {
	const coverage = getSyncCoverage();
	if (coverage === null) return { startDate: fallbackStart, endDate: today, basis: "fallback" };
	const start = shiftDate(coverage.through, -1);
	return { startDate: start > today ? today : start, endDate: today, basis: "coverage" };
}

// Dates given by the caller always win: asking for an old period is how a
// backfill is done. Only a call with no dates at all syncs incrementally.
export function resolveManualSyncRange(
	requested: { startDate?: string; endDate?: string },
	today: string,
	fallback: { startDate: string; endDate: string },
): { startDate: string; endDate: string; basis: "coverage" | "fallback" | "explicit" } {
	if (requested.startDate === undefined && requested.endDate === undefined) {
		return incrementalSyncRange(today, fallback.startDate);
	}
	return {
		startDate: requested.startDate ?? fallback.startDate,
		endDate: requested.endDate ?? fallback.endDate,
		basis: "explicit",
	};
}
