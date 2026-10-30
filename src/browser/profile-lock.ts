import { randomUUID } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { logger } from "../logger.ts";

const LOCK_FILE = "muona.lock";
const CHROMIUM_SINGLETONS = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;
// An unparsable lock file younger than this may be one another process is
// still writing (older versions create it empty, then write), so it is held.
const UNREADABLE_GRACE_MS = 5_000;
// A temp file this old belongs to no acquire still in progress.
const LEFTOVER_TEMP_AGE_MS = 60_000;
const MAX_ACQUIRE_ATTEMPTS = 5;

const lockContents = z.object({
	pid: z.number().int(),
	acquiredAt: z.string(),
	argv: z.array(z.string()),
	bootId: z.string().nullable().optional(),
	startTime: z.string().nullable().optional(),
});

export class ProfileLockedError extends Error {
	// ownerPid null: another process is still writing its lock file.
	constructor(
		readonly ownerPid: number | null,
		readonly acquiredAt: string,
		readonly dir: string,
	) {
		const owner = ownerPid === null ? "another process" : `process ${ownerPid}`;
		super(
			`Browser profile ${dir} is in use by ${owner} (since ${acquiredAt}). Only one process may use the profile at a time; stop that process first.`,
		);
		this.name = "ProfileLockedError";
	}
}

export interface ProfileLock {
	release(): void;
	/** Safe only because we hold the lock: no live process owns these files. */
	removeStaleChromiumLocks(): void;
}

export interface ProfileLockDeps {
	pid?: number;
	isAlive?: (pid: number) => boolean;
	now?: () => number;
	bootId?: string | null;
	startTimeOf?: (pid: number) => string | null;
	// The exclusive create; tests interpose here to act as another process
	// between two steps of an acquire.
	link?: (from: string, to: string) => void;
}

// A pid only identifies a process within one boot; after a reboot the old
// owner's pid may belong to an unrelated live process.
const readBootId = (): string | null => {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
	} catch {
		return null;
	}
};

const defaultIsAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
};

// Field 22 of /proc/<pid>/stat (start time in clock ticks since boot). Inside
// a container a restart keeps the host's boot_id, so this is what tells a
// reused pid apart from the process that wrote the lock.
const readStartTime = (pid: number): string | null => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) may contain spaces and parentheses; fields after it are plain.
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return rest[19] ?? null;
	} catch {
		return null;
	}
};

const parseOwner = (raw: string): z.infer<typeof lockContents> | null => {
	try {
		return lockContents.parse(JSON.parse(raw));
	} catch {
		return null;
	}
};

// null: no lock file (any other read error is treated as an unreadable one).
const readRaw = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		return "";
	}
};

const readOwner = (path: string): z.infer<typeof lockContents> | null => {
	const raw = readRaw(path);
	return raw === null ? null : parseOwner(raw);
};

const isExistsError = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "EEXIST";

// link() of a fully written temp file is an exclusive create that never
// exposes an empty lock file, unlike O_EXCL followed by a write.
const createWithContent = (
	path: string,
	body: string,
	link: (from: string, to: string) => void,
): boolean => {
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, body, { flag: "wx" });
	try {
		link(temp, path);
		return true;
	} catch (error) {
		if (isExistsError(error)) return false;
		throw error;
	} finally {
		rmSync(temp, { force: true });
	}
};

// Removing by path could delete a lock another process created after we
// judged the old one stale. Renaming first takes exactly one file; if it is
// not the stale one we saw, or cannot be read to tell, it goes straight back
// and is never deleted unjudged. Known limitation, accepted for a single-user
// tool: a third process creating the lock during the rename/link-back window
// can still leave two holders.
type Takeover = "removed" | "changed" | "unreadable";

const removeIfUnchanged = (path: string, staleRaw: string): Takeover => {
	const aside = `${path}.${randomUUID()}.stale.tmp`;
	try {
		renameSync(path, aside);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "changed";
		throw error;
	}
	let raw: string | null = null;
	try {
		raw = readFileSync(aside, "utf8");
	} catch (error) {
		logger.warn(
			{ path, err: error },
			"Profile lock could not be read during the takeover; putting it back",
		);
	}
	if (raw === staleRaw) {
		rmSync(aside, { force: true });
		return "removed";
	}
	try {
		linkSync(aside, path);
	} catch (error) {
		if (!isExistsError(error)) throw error;
		logger.warn(
			{ path, aside },
			"Profile lock taken by a third process while one was being restored; the moved file is kept",
		);
		// Unread content is never deleted; a read one that lost its place is.
		if (raw !== null) rmSync(aside, { force: true });
		return raw === null ? "unreadable" : "changed";
	}
	// The lock is back at its path; the aside name is only a second link.
	rmSync(aside, { force: true });
	return raw === null ? "unreadable" : "changed";
};

// Left by a process that died between writing its temp file and the link.
const removeLeftoverTemps = (dir: string): void => {
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(`${LOCK_FILE}.`) || !name.endsWith(".tmp")) continue;
		const file = join(dir, name);
		const at = modifiedAt(file);
		if (at === null || Date.now() - at < LEFTOVER_TEMP_AGE_MS) continue;
		rmSync(file, { force: true });
		logger.info({ file }, "Removed a leftover profile lock temp file");
	}
};

const modifiedAt = (path: string): number | null => {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
};

// One shared handler instead of one per lock avoids MaxListeners warnings.
const held = new Set<() => void>();
let exitHandlerInstalled = false;
const installExitHandler = () => {
	if (exitHandlerInstalled) return;
	exitHandlerInstalled = true;
	process.on("exit", () => {
		for (const release of [...held]) release();
	});
};

export function acquireProfileLock(dir: string, deps: ProfileLockDeps = {}): ProfileLock {
	const pid = deps.pid ?? process.pid;
	const isAlive = deps.isAlive ?? defaultIsAlive;
	const now = deps.now ?? Date.now;
	const bootId = deps.bootId === undefined ? readBootId() : deps.bootId;
	const startTimeOf = deps.startTimeOf ?? readStartTime;
	const link = deps.link ?? linkSync;
	const path = join(dir, LOCK_FILE);
	mkdirSync(dir, { recursive: true });

	const body = () =>
		JSON.stringify({
			pid,
			acquiredAt: new Date(now()).toISOString(),
			argv: process.argv,
			bootId,
			startTime: startTimeOf(pid),
		});

	removeLeftoverTemps(dir);

	// Each pass either creates the lock, finds it held (throws), or clears the
	// way for the next pass (stale lock removed, lock vanished, lock changed
	// under us). Bounded so two processes fighting over it cannot spin.
	for (let attempt = 1; ; attempt++) {
		if (attempt > MAX_ACQUIRE_ATTEMPTS) {
			throw new Error(
				`Profile lock ${path} kept changing hands; gave up after ${MAX_ACQUIRE_ATTEMPTS} attempts`,
			);
		}
		if (createWithContent(path, body(), link)) {
			logger.info({ dir, pid }, "Profile lock acquired");
			break;
		}
		const raw = readRaw(path);
		if (raw === null) {
			logger.info({ dir, pid, attempt }, "Profile lock released before it could be read; retrying");
			continue;
		}
		const owner = parseOwner(raw);
		if (owner?.pid === pid) {
			break;
		}
		// mtime is the filesystem's clock, so compare with the real one, not now().
		const writtenAt = owner ? null : modifiedAt(path);
		if (writtenAt !== null && Date.now() - writtenAt < UNREADABLE_GRACE_MS) {
			logger.info(
				{ dir, pid, ageMs: Date.now() - writtenAt },
				"Profile lock file is unreadable but fresh: another process is still writing it",
			);
			throw new ProfileLockedError(null, new Date(writtenAt).toISOString(), dir);
		}
		const ownerFromEarlierBoot = Boolean(owner?.bootId && bootId && owner.bootId !== bootId);
		const ownerStartTime = owner?.startTime;
		const pidReused = Boolean(owner && ownerStartTime && startTimeOf(owner.pid) !== ownerStartTime);
		const ownerGone = ownerFromEarlierBoot || pidReused;
		if (owner && !ownerGone && isAlive(owner.pid)) {
			throw new ProfileLockedError(owner.pid, owner.acquiredAt, dir);
		}
		logger.info(
			{ dir, pid, stalePid: owner?.pid ?? null, ownerFromEarlierBoot, pidReused },
			"Taking over stale profile lock",
		);
		const takeover = removeIfUnchanged(path, raw);
		if (takeover === "unreadable") {
			throw new ProfileLockedError(
				null,
				new Date(modifiedAt(path) ?? Date.now()).toISOString(),
				dir,
			);
		}
		if (takeover === "changed") {
			logger.info({ dir, pid, attempt }, "Profile lock changed during the takeover; re-evaluating");
		}
	}

	let released = false;
	const release = () => {
		held.delete(release);
		if (released) return;
		released = true;
		if (readOwner(path)?.pid !== pid) return;
		rmSync(path, { force: true });
		logger.info({ dir, pid }, "Profile lock released");
	};
	held.add(release);
	installExitHandler();

	return {
		release,
		removeStaleChromiumLocks: () => {
			for (const name of CHROMIUM_SINGLETONS) rmSync(join(dir, name), { force: true });
		},
	};
}
