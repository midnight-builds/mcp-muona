import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLoginAges, hoursBetween, recordLogin } from "./login-history.ts";
import { closeSettingsDb } from "./settings.ts";

let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `muona-login-history-${randomUUID()}.sqlite`);
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

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-17T21:21:00Z");

describe("hoursBetween", () => {
	test("rounds to one decimal and handles a missing start", () => {
		expect(hoursBetween("2026-10-17T21:21:00.000Z", T0 + 1.26 * HOUR)).toBe(1.3);
		expect(hoursBetween(null, T0)).toBeNull();
	});
});

describe("login history", () => {
	test("nothing recorded yet gives null ages", () => {
		expect(getLoginAges(T0)).toEqual({
			lastHumanLoginAt: null,
			lastSilentLoginAt: null,
			hoursSinceHumanLogin: null,
			hoursSinceSilentLogin: null,
		});
	});

	test("records human and silent logins separately and ages them", () => {
		recordLogin("human", T0);
		recordLogin("silent_sso", T0 + 30 * HOUR);
		expect(getLoginAges(T0 + 48 * HOUR)).toEqual({
			lastHumanLoginAt: "2026-10-17T21:21:00.000Z",
			lastSilentLoginAt: "2026-10-19T03:21:00.000Z",
			hoursSinceHumanLogin: 48,
			hoursSinceSilentLogin: 18,
		});
	});

	test("recordLogin returns the ages as they were before this login", () => {
		recordLogin("human", T0);
		const before = recordLogin("human", T0 + 72 * HOUR);
		expect(before.hoursSinceHumanLogin).toBe(72);
		expect(getLoginAges(T0 + 72 * HOUR).hoursSinceHumanLogin).toBe(0);
	});
});
