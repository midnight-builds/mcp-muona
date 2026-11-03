import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSettingsDb, setSetting } from "./settings.ts";
import {
	getSyncCoverage,
	incrementalSyncRange,
	recordSyncedRange,
	resolveManualSyncRange,
	SYNC_COVERAGE_SETTING_KEY,
} from "./sync-coverage.ts";

let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `muona-coverage-test-${randomUUID()}.sqlite`);
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

const NOW = new Date("2026-11-03T10:00:00.000Z");
const LATER = new Date("2026-11-03T11:00:00.000Z");

describe("recordSyncedRange", () => {
	test("starts coverage from a sync that reaches today", () => {
		recordSyncedRange({ startDate: "2026-10-21", endDate: "2026-11-03" }, "2026-11-03", NOW);
		expect(getSyncCoverage()).toEqual({ through: "2026-11-03", at: NOW.toISOString() });
	});

	test("an old backfill without coverage says nothing about recent days", () => {
		recordSyncedRange({ startDate: "2025-01-01", endDate: "2025-12-31" }, "2026-11-03", NOW);
		expect(getSyncCoverage()).toBeNull();
	});

	test("clamps an end date in the future to today", () => {
		recordSyncedRange({ startDate: "2026-11-01", endDate: "2026-11-30" }, "2026-11-03", NOW);
		expect(getSyncCoverage()?.through).toBe("2026-11-03");
	});

	test("advances over a range that overlaps or touches the covered day", () => {
		recordSyncedRange({ startDate: "2026-10-20", endDate: "2026-11-01" }, "2026-11-01", NOW);
		recordSyncedRange({ startDate: "2026-11-02", endDate: "2026-11-03" }, "2026-11-03", LATER);
		expect(getSyncCoverage()).toEqual({ through: "2026-11-03", at: LATER.toISOString() });
	});

	test("does not jump a gap: a range starting after the covered day plus one leaves a hole", () => {
		recordSyncedRange({ startDate: "2026-10-20", endDate: "2026-10-25" }, "2026-10-25", NOW);
		recordSyncedRange({ startDate: "2026-11-03", endDate: "2026-11-03" }, "2026-11-03", LATER);
		expect(getSyncCoverage()).toEqual({ through: "2026-10-25", at: NOW.toISOString() });
	});

	test("a range inside the coverage keeps the day but refreshes when it last succeeded", () => {
		recordSyncedRange({ startDate: "2026-10-20", endDate: "2026-11-03" }, "2026-11-03", NOW);
		recordSyncedRange({ startDate: "2026-11-02", endDate: "2026-11-02" }, "2026-11-03", LATER);
		expect(getSyncCoverage()).toEqual({ through: "2026-11-03", at: LATER.toISOString() });
	});

	test("ignores an unreadable stored value and starts over", () => {
		setSetting(SYNC_COVERAGE_SETTING_KEY, "{not json");
		expect(getSyncCoverage()).toBeNull();
		recordSyncedRange({ startDate: "2026-11-01", endDate: "2026-11-03" }, "2026-11-03", NOW);
		expect(getSyncCoverage()?.through).toBe("2026-11-03");
	});
});

describe("incrementalSyncRange", () => {
	test("falls back to the given start when nothing is covered yet", () => {
		expect(incrementalSyncRange("2026-11-03", "2026-10-21")).toEqual({
			startDate: "2026-10-21",
			endDate: "2026-11-03",
			basis: "fallback",
		});
	});

	test("starts one day before the covered day", () => {
		recordSyncedRange({ startDate: "2026-10-21", endDate: "2026-11-03" }, "2026-11-03", NOW);
		expect(incrementalSyncRange("2026-11-03", "2026-10-21")).toEqual({
			startDate: "2026-11-02",
			endDate: "2026-11-03",
			basis: "coverage",
		});
	});

	test("after an outage the range reaches back over the whole gap", () => {
		recordSyncedRange({ startDate: "2026-09-01", endDate: "2026-09-20" }, "2026-09-20", NOW);
		expect(incrementalSyncRange("2026-11-03", "2026-10-21").startDate).toBe("2026-09-19");
	});

	test("crosses month and year boundaries", () => {
		recordSyncedRange({ startDate: "2026-12-20", endDate: "2027-01-01" }, "2027-01-01", NOW);
		expect(incrementalSyncRange("2027-01-01", "2026-12-19").startDate).toBe("2026-12-31");
	});

	test("never starts after today when the stored day is ahead of the clock", () => {
		recordSyncedRange({ startDate: "2026-11-01", endDate: "2026-11-10" }, "2026-11-10", NOW);
		expect(incrementalSyncRange("2026-11-03", "2026-10-21")).toEqual({
			startDate: "2026-11-03",
			endDate: "2026-11-03",
			basis: "coverage",
		});
	});
});

describe("resolveManualSyncRange", () => {
	const fallback = { startDate: "2026-09-01", endDate: "2026-11-03" };

	test("without dates syncs incrementally from the coverage", () => {
		recordSyncedRange({ startDate: "2026-10-21", endDate: "2026-11-02" }, "2026-11-02", NOW);
		expect(resolveManualSyncRange({}, "2026-11-03", fallback)).toEqual({
			startDate: "2026-11-01",
			endDate: "2026-11-03",
			basis: "coverage",
		});
	});

	test("without dates and without coverage uses the fallback range", () => {
		expect(resolveManualSyncRange({}, "2026-11-03", fallback)).toEqual({
			...fallback,
			basis: "fallback",
		});
	});

	test("explicit dates win and missing ones come from the fallback, never from coverage", () => {
		recordSyncedRange({ startDate: "2026-10-21", endDate: "2026-11-02" }, "2026-11-02", NOW);
		expect(resolveManualSyncRange({ startDate: "2025-01-01" }, "2026-11-03", fallback)).toEqual({
			startDate: "2025-01-01",
			endDate: "2026-11-03",
			basis: "explicit",
		});
		expect(resolveManualSyncRange({ endDate: "2026-10-15" }, "2026-11-03", fallback)).toEqual({
			startDate: "2026-09-01",
			endDate: "2026-10-15",
			basis: "explicit",
		});
	});
});
