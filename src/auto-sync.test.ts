import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AutoSyncConfig,
	type AutoSyncDecisionState,
	clampAutoSyncConfig,
	computeNextEligibleAt,
	computeNextRunInWindowAt,
	DEFAULT_AUTO_SYNC_CONFIG,
	getAutoSyncConfig,
	isWithinHelsinkiWindow,
	last14DayRange,
	runAutoSyncAttempt,
	shouldRunNow,
	updateAutoSyncConfig,
} from "./auto-sync.ts";
import { closeSettingsDb, setSetting } from "./store/settings.ts";

let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `muona-autosync-test-${randomUUID()}.sqlite`);
	process.env.MUONA_DB_PATH = dbPath;
});

afterEach(() => {
	closeSettingsDb();
	for (const suffix of ["", "-wal", "-shm"]) {
		const path = `${dbPath}${suffix}`;
		if (existsSync(path)) rmSync(path);
	}
	delete process.env.MUONA_DB_PATH;
});

describe("clampAutoSyncConfig", () => {
	test("passes valid values through unchanged", () => {
		const config = clampAutoSyncConfig({
			enabled: false,
			intervalMinutes: 90,
			windowStartHour: 8,
			windowEndHour: 20,
		});
		expect(config).toEqual({
			enabled: false,
			intervalMinutes: 90,
			windowStartHour: 8,
			windowEndHour: 20,
		});
	});

	test("clamps intervalMinutes into 15-1440", () => {
		expect(clampAutoSyncConfig({ intervalMinutes: 1 }).intervalMinutes).toBe(15);
		expect(clampAutoSyncConfig({ intervalMinutes: 100_000 }).intervalMinutes).toBe(1440);
	});

	test("clamps windowStartHour into 0-23", () => {
		expect(clampAutoSyncConfig({ windowStartHour: -5 }).windowStartHour).toBe(0);
		expect(clampAutoSyncConfig({ windowStartHour: 30 }).windowStartHour).toBe(23);
	});

	test("clamps windowEndHour into 1-24", () => {
		expect(clampAutoSyncConfig({ windowEndHour: 0 }).windowEndHour).toBe(1);
		expect(clampAutoSyncConfig({ windowEndHour: 99 }).windowEndHour).toBe(24);
	});

	test("truncates fractional values", () => {
		expect(clampAutoSyncConfig({ intervalMinutes: 60.9 }).intervalMinutes).toBe(60);
	});

	test("fills in omitted fields from the given base", () => {
		const base: AutoSyncConfig = {
			enabled: false,
			intervalMinutes: 120,
			windowStartHour: 9,
			windowEndHour: 21,
		};
		expect(clampAutoSyncConfig({ intervalMinutes: 45 }, base)).toEqual({
			enabled: false,
			intervalMinutes: 45,
			windowStartHour: 9,
			windowEndHour: 21,
		});
	});
});

describe("getAutoSyncConfig / updateAutoSyncConfig", () => {
	test("falls back to defaults when nothing has been persisted", () => {
		expect(getAutoSyncConfig()).toEqual(DEFAULT_AUTO_SYNC_CONFIG);
	});

	test("falls back to defaults when the persisted value fails schema validation", () => {
		// Directly write an invalid value to simulate corrupted/legacy data.
		setSetting("autosync.config", JSON.stringify({ enabled: "not-a-boolean" }));
		expect(getAutoSyncConfig()).toEqual(DEFAULT_AUTO_SYNC_CONFIG);
	});

	test("persists updates and returns them from subsequent reads", () => {
		updateAutoSyncConfig({ intervalMinutes: 30, enabled: false });
		expect(getAutoSyncConfig()).toEqual({
			enabled: false,
			intervalMinutes: 30,
			windowStartHour: DEFAULT_AUTO_SYNC_CONFIG.windowStartHour,
			windowEndHour: DEFAULT_AUTO_SYNC_CONFIG.windowEndHour,
		});
	});

	test("updateAutoSyncConfig clamps out-of-range values before persisting", () => {
		const status = updateAutoSyncConfig({ intervalMinutes: 5 });
		expect(status.config.intervalMinutes).toBe(15);
		expect(getAutoSyncConfig().intervalMinutes).toBe(15);
	});
});

describe("isWithinHelsinkiWindow", () => {
	const config = DEFAULT_AUTO_SYNC_CONFIG; // 06-23 Helsinki

	test("is true for a time inside the window (13:00 Helsinki, EEST)", () => {
		expect(isWithinHelsinkiWindow(config, new Date("2026-07-21T10:00:00Z"))).toBe(true);
	});

	test("is false before the window opens (03:00 Helsinki)", () => {
		expect(isWithinHelsinkiWindow(config, new Date("2026-07-21T00:00:00Z"))).toBe(false);
	});

	test("is false after the window closes (23:30 Helsinki)", () => {
		expect(isWithinHelsinkiWindow(config, new Date("2026-07-21T20:30:00Z"))).toBe(false);
	});

	test("the window's start hour itself counts as inside", () => {
		expect(isWithinHelsinkiWindow(config, new Date("2026-07-21T03:00:00Z"))).toBe(true); // 06:00 Helsinki
	});

	test("the window's end hour itself counts as outside (exclusive)", () => {
		expect(isWithinHelsinkiWindow(config, new Date("2026-07-21T20:00:00Z"))).toBe(false); // 23:00 Helsinki
	});
});

describe("computeNextRunInWindowAt", () => {
	const config = DEFAULT_AUTO_SYNC_CONFIG; // 06-23 Helsinki

	test("returns the baseline unchanged when it's already inside the window", () => {
		const baseline = new Date("2026-07-21T10:00:00Z"); // 13:00 Helsinki
		expect(computeNextRunInWindowAt(baseline, config)).toEqual(baseline);
	});

	test("rolls forward to today's window opening when baseline is before it", () => {
		const baseline = new Date("2026-07-21T00:00:00Z"); // 03:00 Helsinki
		expect(computeNextRunInWindowAt(baseline, config)).toEqual(new Date("2026-07-21T03:00:00Z"));
	});

	test("rolls forward to tomorrow's window opening when baseline is after it (23:30 -> next day 06:00)", () => {
		const baseline = new Date("2026-07-21T20:30:00Z"); // 23:30 Helsinki
		expect(computeNextRunInWindowAt(baseline, config)).toEqual(new Date("2026-07-22T03:00:00Z"));
	});
});

describe("computeNextEligibleAt", () => {
	test("adds intervalMinutes to now", () => {
		const now = new Date("2026-07-21T10:00:00Z");
		expect(computeNextEligibleAt(now, 60)).toEqual(new Date("2026-07-21T11:00:00Z"));
	});
});

describe("last14DayRange", () => {
	test("spans the 13 days before, plus, today (Helsinki calendar date)", () => {
		// 2026-07-21T10:00:00Z is 2026-07-21 13:00 Helsinki.
		const range = last14DayRange(new Date("2026-07-21T10:00:00Z"));
		expect(range).toEqual({ startDate: "2026-07-08", endDate: "2026-07-21" });
	});

	test("uses the Helsinki calendar date, not the UTC one, near midnight", () => {
		// 2026-07-21T22:00:00Z is 2026-07-22 01:00 Helsinki (EEST, UTC+3).
		const range = last14DayRange(new Date("2026-07-21T22:00:00Z"));
		expect(range.endDate).toBe("2026-07-22");
	});
});

describe("shouldRunNow", () => {
	const enabledConfig = DEFAULT_AUTO_SYNC_CONFIG;
	const insideWindow = new Date("2026-07-21T10:00:00Z"); // 13:00 Helsinki
	const outsideWindow = new Date("2026-07-21T00:00:00Z"); // 03:00 Helsinki
	const freshState: AutoSyncDecisionState = { running: false, nextEligibleAt: null };

	test("runs when enabled, idle, eligible, and inside the window", () => {
		expect(shouldRunNow(enabledConfig, freshState, insideWindow)).toEqual({ run: true });
	});

	test("skips when disabled", () => {
		const config = { ...enabledConfig, enabled: false };
		expect(shouldRunNow(config, freshState, insideWindow)).toEqual({
			run: false,
			reason: "disabled",
		});
	});

	test("skips when already running", () => {
		const state: AutoSyncDecisionState = { running: true, nextEligibleAt: null };
		expect(shouldRunNow(enabledConfig, state, insideWindow)).toEqual({
			run: false,
			reason: "already-running",
		});
	});

	test("skips when not yet eligible", () => {
		const state: AutoSyncDecisionState = {
			running: false,
			nextEligibleAt: "2026-07-21T11:00:00Z",
		};
		expect(shouldRunNow(enabledConfig, state, insideWindow)).toEqual({
			run: false,
			reason: "not-yet-eligible",
		});
	});

	test("runs once nextEligibleAt has passed", () => {
		const state: AutoSyncDecisionState = {
			running: false,
			nextEligibleAt: "2026-07-21T09:59:00Z",
		};
		expect(shouldRunNow(enabledConfig, state, insideWindow)).toEqual({ run: true });
	});

	test("skips when outside the configured window", () => {
		expect(shouldRunNow(enabledConfig, freshState, outsideWindow)).toEqual({
			run: false,
			reason: "outside-window",
		});
	});
});

describe("runAutoSyncAttempt", () => {
	const now = new Date("2026-07-21T10:00:00Z");

	test("records an ok lastRun with counts on success", async () => {
		const result = await runAutoSyncAttempt({
			now,
			syncFn: async (options) => {
				expect(options.startDate).toBe("2026-07-08");
				expect(options.endDate).toBe("2026-07-21");
				expect(options.fetchDelayMs).toBe(400);
				return {
					months: ["2026-07"],
					summariesUpserted: 3,
					detailsFetched: 2,
					parserMismatches: [],
					errors: [],
				};
			},
		});
		expect(result).toEqual({
			at: now.toISOString(),
			ok: true,
			summariesUpserted: 3,
			detailsFetched: 2,
		});
	});

	test("records a failed lastRun with the error message, including SessionExpiredError", async () => {
		const result = await runAutoSyncAttempt({
			now,
			syncFn: async () => {
				throw new Error("Not logged in to s-etukortti.fi.");
			},
		});
		expect(result).toEqual({
			at: now.toISOString(),
			ok: false,
			error: "Not logged in to s-etukortti.fi.",
		});
	});

	test("stringifies non-Error throws", async () => {
		const result = await runAutoSyncAttempt({
			now,
			syncFn: async () => {
				throw "boom";
			},
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("boom");
	});
});
