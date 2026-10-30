import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { acquireProfileLock, ProfileLockedError } from "./profile-lock.ts";

const lockContents = z.object({
	pid: z.number(),
	acquiredAt: z.string(),
	argv: z.array(z.string()),
});

let dir: string;
let lockPath: string;

beforeEach(() => {
	dir = join(tmpdir(), `profile-lock-${crypto.randomUUID()}`);
	lockPath = join(dir, "muona.lock");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// An unparsable lock file this old is debris, not a lock being written.
const backdate = (path: string) => {
	const old = new Date(Date.now() - 60_000);
	utimesSync(path, old, old);
};

const readLock = () => lockContents.parse(JSON.parse(readFileSync(lockPath, "utf8")));
const readLockRaw = () =>
	z.object({ startTime: z.string().nullable() }).parse(JSON.parse(readFileSync(lockPath, "utf8")));

describe("acquireProfileLock", () => {
	test("fresh acquire writes the lock file, creating the directory", () => {
		acquireProfileLock(dir, { pid: 111, now: () => Date.parse("2026-01-02T03:04:05.000Z") });
		const contents = readLock();
		expect(contents.pid).toBe(111);
		expect(contents.acquiredAt).toBe("2026-01-02T03:04:05.000Z");
		expect(Array.isArray(contents.argv)).toBe(true);
	});

	test("throws ProfileLockedError when a live foreign pid holds the lock", () => {
		acquireProfileLock(dir, { pid: 111 });
		const attempt = () => acquireProfileLock(dir, { pid: 222, isAlive: () => true });
		expect(attempt).toThrow(ProfileLockedError);
		try {
			attempt();
		} catch (error) {
			expect(error).toBeInstanceOf(ProfileLockedError);
			if (error instanceof ProfileLockedError) {
				expect(error.ownerPid).toBe(111);
				expect(error.message).toContain("111");
			}
		}
		expect(readLock().pid).toBe(111);
	});

	test("takes over when the owner is dead", () => {
		acquireProfileLock(dir, { pid: 111 });
		acquireProfileLock(dir, { pid: 222, isAlive: () => false });
		expect(readLock().pid).toBe(222);
	});

	// After a reboot the old pid may belong to an unrelated live process; a
	// pid check alone would then keep the server from ever starting.
	test("takes over a lock from a previous boot even if its pid is alive", () => {
		acquireProfileLock(dir, { pid: 111, bootId: "boot-a" });
		acquireProfileLock(dir, { pid: 222, bootId: "boot-b", isAlive: () => true });
		expect(readLock().pid).toBe(222);
	});

	test("a live owner from the same boot still blocks", () => {
		acquireProfileLock(dir, { pid: 111, bootId: "boot-a" });
		const attempt = () =>
			acquireProfileLock(dir, { pid: 222, bootId: "boot-a", isAlive: () => true });
		expect(attempt).toThrow(ProfileLockedError);
	});

	// Inside an LXC container boot_id is the host's, so a container restart
	// keeps it; the owner's process start time tells a reused pid apart.
	test("takes over when the pid now belongs to a process started later", () => {
		acquireProfileLock(dir, { pid: 111, bootId: "boot-a", startTimeOf: () => "1000" });
		acquireProfileLock(dir, {
			pid: 222,
			bootId: "boot-a",
			isAlive: () => true,
			startTimeOf: (pid) => (pid === 111 ? "5000" : "6000"),
		});
		expect(readLock().pid).toBe(222);
	});

	test("an owner whose start time still matches blocks", () => {
		acquireProfileLock(dir, { pid: 111, bootId: "boot-a", startTimeOf: () => "1000" });
		const attempt = () =>
			acquireProfileLock(dir, {
				pid: 222,
				bootId: "boot-a",
				isAlive: () => true,
				startTimeOf: (pid) => (pid === 111 ? "1000" : "6000"),
			});
		expect(attempt).toThrow(ProfileLockedError);
	});

	test("default start time reads /proc for a live process", () => {
		acquireProfileLock(dir);
		expect(readLockRaw().startTime).toMatch(/^\d+$/);
	});

	test("takes over a corrupt lock file", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(lockPath, "not json{");
		backdate(lockPath);
		acquireProfileLock(dir, { pid: 222, isAlive: () => true });
		expect(readLock().pid).toBe(222);
	});

	test("takes over a lock file with the wrong shape", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ pid: "x" }));
		backdate(lockPath);
		acquireProfileLock(dir, { pid: 222, isAlive: () => true });
		expect(readLock().pid).toBe(222);
	});

	// Another process's create and its write are two steps (O_EXCL, then
	// write): in between the file is empty. Taking that over as stale left
	// both processes holding the lock.
	test("a fresh empty lock file counts as held", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(lockPath, "");
		expect(() => acquireProfileLock(dir, { pid: 222, isAlive: () => true })).toThrow(
			ProfileLockedError,
		);
		expect(readFileSync(lockPath, "utf8")).toBe("");
	});

	// The freshness rule compares the file's real mtime with the real clock;
	// an injected now() for acquiredAt must not age a file being written.
	test("a fresh empty lock file is held whatever the injected now()", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(lockPath, "");
		const later = () => Date.now() + 3_600_000;
		expect(() => acquireProfileLock(dir, { pid: 222, isAlive: () => true, now: later })).toThrow(
			ProfileLockedError,
		);
	});

	// Two processes taking over the same stale lock: the slower one must not
	// delete the lock the faster one has just created.
	test("a takeover never removes a lock another process created meanwhile", () => {
		acquireProfileLock(dir, { pid: 111 });
		const otherTakesOver = () => {
			rmSync(lockPath);
			writeFileSync(
				lockPath,
				JSON.stringify({ pid: 333, acquiredAt: new Date().toISOString(), argv: [] }),
			);
		};
		const isAlive = (p: number) => {
			if (p === 111) {
				otherTakesOver();
				return false;
			}
			return true;
		};
		expect(() => acquireProfileLock(dir, { pid: 222, isAlive })).toThrow(ProfileLockedError);
		expect(readLock().pid).toBe(333);
		expect(readdirSync(dir)).toEqual(["muona.lock"]);
	});

	// A lock we cannot read is never removed unjudged.
	test("an unreadable stale-looking lock is put back and counted as held", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ pid: 111, acquiredAt: "x", argv: [] }));
		backdate(lockPath);
		chmodSync(lockPath, 0o000);
		expect(() => acquireProfileLock(dir, { pid: 222, isAlive: () => false })).toThrow(
			ProfileLockedError,
		);
		expect(existsSync(lockPath)).toBe(true);
		expect(readdirSync(dir)).toEqual(["muona.lock"]);
		chmodSync(lockPath, 0o600);
	});

	// The owner released normally between our failed link and the read.
	test("a lock that vanishes after a failed create is retried, not taken as stale", () => {
		acquireProfileLock(dir, { pid: 111 });
		let links = 0;
		const link = (from: string, to: string) => {
			links++;
			if (links === 2) {
				writeFileSync(to, JSON.stringify({ pid: 444, acquiredAt: "x", argv: [] }));
				try {
					linkSync(from, to);
				} finally {
					rmSync(to);
				}
			}
			linkSync(from, to);
		};
		acquireProfileLock(dir, { pid: 222, isAlive: () => false, link });
		expect(readLock().pid).toBe(222);
	});

	// A process that died between the temp write and the link left its temp file.
	test("acquire removes leftover temp files older than a minute, not fresh ones", () => {
		mkdirSync(dir, { recursive: true });
		const old = join(dir, "muona.lock.dead.tmp");
		const fresh = join(dir, "muona.lock.writing.tmp");
		writeFileSync(old, "{}");
		backdate(old);
		writeFileSync(fresh, "{}");
		acquireProfileLock(dir, { pid: 111 });
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	test("the lock file appears with its full content and leaves no temp file", () => {
		acquireProfileLock(dir, { pid: 111 });
		expect(readLock().pid).toBe(111);
		expect(readdirSync(dir)).toEqual(["muona.lock"]);
	});

	test("re-acquire by the same pid is idempotent", () => {
		acquireProfileLock(dir, { pid: 111, isAlive: () => true });
		acquireProfileLock(dir, { pid: 111, isAlive: () => true });
		expect(readLock().pid).toBe(111);
	});

	test("default isAlive treats our own pid as alive and a nonexistent pid as dead", () => {
		acquireProfileLock(dir, { pid: 2 ** 22 + 12345 });
		const lock = acquireProfileLock(dir, { pid: process.pid });
		expect(readLock().pid).toBe(process.pid);
		lock.release();
		acquireProfileLock(dir, { pid: process.ppid });
		expect(() => acquireProfileLock(dir, { pid: process.pid })).toThrow(ProfileLockedError);
	});
});

describe("release", () => {
	test("removes our own lock and is idempotent", () => {
		const lock = acquireProfileLock(dir, { pid: 111 });
		lock.release();
		expect(existsSync(lockPath)).toBe(false);
		expect(() => lock.release()).not.toThrow();
	});

	test("leaves the file alone after another process took over", () => {
		const lock = acquireProfileLock(dir, { pid: 111 });
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 222, acquiredAt: new Date().toISOString(), argv: [] }),
		);
		lock.release();
		expect(readLock().pid).toBe(222);
	});
});

describe("removeStaleChromiumLocks", () => {
	test("removes the three Singleton files but keeps our lock", () => {
		const lock = acquireProfileLock(dir, { pid: 111 });
		const names = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
		for (const name of names) writeFileSync(join(dir, name), "");
		lock.removeStaleChromiumLocks();
		for (const name of names) expect(existsSync(join(dir, name))).toBe(false);
		expect(existsSync(lockPath)).toBe(true);
	});

	test("does not throw when the files are absent", () => {
		const lock = acquireProfileLock(dir, { pid: 111 });
		expect(() => lock.removeStaleChromiumLocks()).not.toThrow();
	});
});
