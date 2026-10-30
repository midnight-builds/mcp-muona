import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSettingsDb, deleteSetting, getSetting, setSetting } from "./settings.ts";

let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `muona-settings-test-${randomUUID()}.sqlite`);
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

describe("getSetting / setSetting", () => {
	test("returns null for a key that was never set", () => {
		expect(getSetting("does.not.exist")).toBeNull();
	});

	test("round-trips a value through set then get", () => {
		setSetting("autosync.config", '{"enabled":true}');
		expect(getSetting("autosync.config")).toBe('{"enabled":true}');
	});

	test("overwrites an existing value rather than erroring", () => {
		setSetting("k", "first");
		setSetting("k", "second");
		expect(getSetting("k")).toBe("second");
	});

	test("keys are independent of one another", () => {
		setSetting("a", "1");
		setSetting("b", "2");
		expect(getSetting("a")).toBe("1");
		expect(getSetting("b")).toBe("2");
	});

	test("deleteSetting removes a key and is a no-op for missing keys", () => {
		setSetting("k", "v");
		deleteSetting("k");
		expect(getSetting("k")).toBeNull();
		deleteSetting("never.set");
	});
});
