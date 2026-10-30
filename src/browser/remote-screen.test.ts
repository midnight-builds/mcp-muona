import { describe, expect, test } from "bun:test";
import {
	buildViewerUrl,
	createRemoteScreen,
	generateVncPassword,
	type RemoteScreenDeps,
} from "./remote-screen.ts";

describe("generateVncPassword", () => {
	test("is 8 alphanumerics (classic VNC auth ignores anything longer)", () => {
		const a = generateVncPassword();
		expect(a).toMatch(/^[A-Za-z0-9]{8}$/);
		expect(generateVncPassword()).not.toBe(a);
	});
});

describe("buildViewerUrl", () => {
	test("points at noVNC with mobile-friendly options and the password", () => {
		const url = new URL(buildViewerUrl("https://host.ts.net:8445/", "Ab3dEf7h"));
		expect(url.origin).toBe("https://host.ts.net:8445");
		expect(url.pathname).toBe("/vnc.html");
		expect(url.searchParams.get("autoconnect")).toBe("1");
		expect(url.searchParams.get("resize")).toBe("scale");
		expect(url.searchParams.get("reconnect")).toBe("1");
		expect(url.searchParams.get("password")).toBe("Ab3dEf7h");
	});
});

type FakeProc = { cmd: string[]; killed: boolean; exit: (code: number) => void };

function harness(phase = "awaiting_strong_auth") {
	const procs: FakeProc[] = [];
	const state = {
		phase,
		now: 1_000_000,
		fronted: 0,
		holds: 0,
		passwordFiles: [] as string[],
		removedFiles: [] as string[],
		portsReady: true,
		messages: [] as string[],
		messageClosed: 0,
		scheduled: [] as (() => void)[],
		failSpawn: null as string | null,
	};
	let tick: (() => void) | null = null;
	const deps: RemoteScreenDeps = {
		config: () => ({
			display: ":99",
			vncPort: 5901,
			wsPort: 6080,
			publicUrl: "https://host.ts.net:8445",
			novncDir: "/usr/share/novnc",
			ttlMs: 15 * 60_000,
		}),
		spawn: (cmd) => {
			if (cmd[0] === state.failSpawn) throw new Error(`${cmd[0]}: not found`);
			let resolveExit: (code: number) => void = () => {};
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			const proc: FakeProc = { cmd, killed: false, exit: (c) => resolveExit(c) };
			procs.push(proc);
			return {
				exited,
				kill: () => {
					proc.killed = true;
					resolveExit(0);
				},
			};
		},
		writePasswordFile: (password) => {
			state.passwordFiles.push(password);
			return "/tmp/pw";
		},
		removeFile: (path) => {
			state.removedFiles.push(path);
		},
		waitForPort: async () => state.portsReady,
		showMessage: async (message) => {
			state.messages.push(message.title);
			return async () => {
				state.messageClosed++;
			};
		},
		schedule: (fn) => {
			state.scheduled.push(fn);
		},
		holdLogin: async () => {
			state.holds++;
			return state.phase;
		},
		bringLoginPageToFront: async () => {
			state.fronted++;
			return true;
		},
		now: () => state.now,
		startTicker: (fn) => {
			tick = fn;
			return () => {
				tick = null;
			};
		},
	};
	return {
		procs,
		state,
		screen: createRemoteScreen(deps),
		tick: async () => {
			tick?.();
			await new Promise((r) => setTimeout(r, 0));
		},
		hasTicker: () => tick !== null,
		runScheduled: async () => {
			for (const fn of state.scheduled.splice(0)) fn();
			await new Promise((r) => setTimeout(r, 0));
		},
	};
}

describe("remote screen manager", () => {
	test("refuses to open unless the login waits for strong authentication", async () => {
		const h = harness("awaiting_otp");
		await expect(h.screen.open()).rejects.toThrow(/awaiting_strong_auth/);
		expect(h.procs).toHaveLength(0);
	});

	test("opens x11vnc on localhost and websockify, then reports the viewer URL", async () => {
		const h = harness();
		const status = await h.screen.open();
		expect(status.open).toBe(true);
		expect(status.url).toContain("https://host.ts.net:8445/vnc.html");
		const [vnc, ws] = h.procs;
		expect(vnc?.cmd).toEqual(expect.arrayContaining(["x11vnc", "-localhost", "-display", ":99"]));
		expect(vnc?.cmd).toEqual(expect.arrayContaining(["-passwdfile", "rm:/tmp/pw"]));
		expect(vnc?.cmd).toEqual(expect.arrayContaining(["-noclipboard", "-nosetclipboard"]));
		expect(ws?.cmd).toEqual(expect.arrayContaining(["websockify", "127.0.0.1:6080"]));
		expect(h.state.fronted).toBe(1);
		expect(h.state.passwordFiles).toHaveLength(1);
	});

	test("a second open returns the live session instead of spawning again", async () => {
		const h = harness();
		const first = await h.screen.open();
		const second = await h.screen.open();
		expect(second.url).toBe(first.url);
		expect(h.procs).toHaveLength(2);
	});

	test("closes automatically once the login leaves awaiting_strong_auth", async () => {
		const h = harness();
		await h.screen.open();
		h.state.phase = "logged_in";
		await h.tick();
		await h.runScheduled();
		expect(h.procs.every((p) => p.killed)).toBe(true);
		expect(h.screen.status()).toMatchObject({ open: false, lastCloseReason: "login_logged_in" });
		expect(h.hasTicker()).toBe(false);
	});

	test("closes after the time limit", async () => {
		const h = harness();
		await h.screen.open();
		h.state.now += 15 * 60_000 + 1;
		await h.tick();
		expect(h.screen.status()).toMatchObject({ open: false, lastCloseReason: "timeout" });
	});

	test("closes everything if one of the processes dies", async () => {
		const h = harness();
		await h.screen.open();
		h.procs[1]?.exit(1);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.procs[0]?.killed).toBe(true);
		expect(h.screen.status()).toMatchObject({ open: false, lastCloseReason: "websockify_exited" });
	});

	test("keeps the login page in front while open", async () => {
		const h = harness();
		await h.screen.open();
		await h.tick();
		await h.tick();
		expect(h.state.fronted).toBe(3);
	});

	test("concurrent opens spawn only one set of processes", async () => {
		const h = harness();
		const [a, b] = await Promise.all([h.screen.open(), h.screen.open()]);
		expect(a.url).toBe(b.url);
		expect(h.procs).toHaveLength(2);
	});

	test("fails and cleans up when the ports never come up", async () => {
		const h = harness();
		h.state.portsReady = false;
		await expect(h.screen.open()).rejects.toThrow(/did not start/);
		expect(h.procs.every((p) => p.killed)).toBe(true);
		expect(h.state.removedFiles).toEqual(["/tmp/pw"]);
		expect(h.screen.status().open).toBe(false);
		expect(h.hasTicker()).toBe(false);
	});

	test("kills the already-started process when a later spawn throws", async () => {
		const h = harness();
		h.state.failSpawn = "websockify";
		await expect(h.screen.open()).rejects.toThrow(/not found/);
		expect(h.procs).toHaveLength(1);
		expect(h.procs[0]?.killed).toBe(true);
		expect(h.state.removedFiles).toEqual(["/tmp/pw"]);
	});

	test("removes the password file on close in case x11vnc never read it", async () => {
		const h = harness();
		await h.screen.open();
		h.screen.close("manual");
		expect(h.state.removedFiles).toEqual(["/tmp/pw"]);
	});

	test("holds the login open on every check so the stale-login reaper can't fire", async () => {
		const h = harness();
		await h.screen.open();
		const before = h.state.holds;
		await h.tick();
		await h.tick();
		expect(h.state.holds).toBe(before + 2);
	});

	test("shows a success message on the screen before tearing down", async () => {
		const h = harness();
		await h.screen.open();
		h.state.phase = "logged_in";
		await h.tick();
		expect(h.state.messages).toEqual(["Kirjautuminen onnistui"]);
		expect(h.procs.some((p) => p.killed)).toBe(false);
		expect(h.screen.status().open).toBe(false);
		await h.runScheduled();
		expect(h.procs.every((p) => p.killed)).toBe(true);
		expect(h.state.messageClosed).toBe(1);
	});

	test("shows a timeout message when the time limit ends the screen", async () => {
		const h = harness();
		await h.screen.open();
		h.state.now += 15 * 60_000 + 1;
		await h.tick();
		expect(h.state.messages).toEqual(["Aika loppui"]);
	});

	test("manual close and crashed processes tear down immediately without a message", async () => {
		const h = harness();
		await h.screen.open();
		h.screen.close("manual");
		expect(h.procs.every((p) => p.killed)).toBe(true);
		expect(h.state.messages).toEqual([]);
	});

	test("reopening while a message lingers tears the old session down first", async () => {
		const h = harness();
		await h.screen.open();
		h.state.phase = "logged_in";
		await h.tick();
		h.state.phase = "awaiting_strong_auth";
		await h.screen.open();
		expect(h.procs.slice(0, 2).every((p) => p.killed)).toBe(true);
		expect(h.procs).toHaveLength(4);
		await h.runScheduled();
		expect(h.procs.slice(2).some((p) => p.killed)).toBe(false);
	});

	test("explicit close is idempotent", async () => {
		const h = harness();
		await h.screen.open();
		h.screen.close("manual");
		h.screen.close("manual");
		expect(h.screen.status()).toMatchObject({ open: false, lastCloseReason: "manual" });
	});
});
