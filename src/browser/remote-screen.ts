// Live view of the S-Etukortti login browser for strong authentication by bank
// credentials: those must be typed by the human straight into the bank page,
// never relayed through the agent chat. The browser runs headed on an Xvfb
// display; on demand this exposes that display via x11vnc + noVNC (websockify),
// both bound to localhost. Reachability from the phone comes solely from a
// `tailscale serve` mapping (tailnet-only HTTPS) onto the websockify port —
// when nothing is open, that mapping just returns 502.

import { spawn as spawnProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger.ts";
import { getContext, sGroup } from "./s-group/index.ts";

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

// Classic VNC auth only uses the first 8 characters. It is a second lock only;
// the real boundary is that the port is reachable solely over the tailnet.
export function generateVncPassword(): string {
	let out = "";
	for (let i = 0; i < 8; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
	return out;
}

// reconnect=1 matters on a phone: the user switches to the bank app to approve
// and the browser tab's websocket is often dropped meanwhile.
export function buildViewerUrl(publicUrl: string, password: string): string {
	const url = new URL("/vnc.html", publicUrl);
	url.searchParams.set("autoconnect", "1");
	url.searchParams.set("resize", "scale");
	url.searchParams.set("reconnect", "1");
	url.searchParams.set("password", password);
	return url.toString();
}

export type RemoteScreenConfig = {
	display: string;
	vncPort: number;
	wsPort: number;
	publicUrl: string;
	novncDir: string;
	ttlMs: number;
};

type SpawnedProcess = { exited: Promise<number>; kill: () => void };

export type RemoteScreenDeps = {
	config: () => RemoteScreenConfig;
	spawn: (cmd: string[]) => SpawnedProcess;
	writePasswordFile: (password: string) => string;
	removeFile: (path: string) => void;
	waitForPort: (port: number, timeoutMs: number) => Promise<boolean>;
	// Returns the login phase, and while it is awaiting_strong_auth also marks
	// the attempt active so the stale-login reaper leaves it alone.
	holdLogin: () => Promise<string>;
	// Puts a full-screen note on the display; returns a function removing it.
	showMessage: (message: ScreenMessage) => Promise<() => Promise<void>>;
	schedule: (fn: () => void, ms: number) => void;
	bringLoginPageToFront: () => Promise<boolean>;
	now: () => number;
	startTicker: (fn: () => void) => () => void;
};

export type RemoteScreenStatus = {
	open: boolean;
	url: string | null;
	openedAt: string | null;
	expiresAt: string | null;
	lastCloseReason: string | null;
};

export type ScreenMessage = { title: string; body: string; success: boolean };

const REQUIRED_PHASE = "awaiting_strong_auth";
// Long enough to read the outcome on the phone before the stream goes away.
const MESSAGE_LINGER_MS = 15_000;

// Only endings the human didn't cause themselves get a note on the screen;
// manual closes and crashed processes have no one (or nothing) to show it to.
function messageFor(reason: string): ScreenMessage | null {
	if (reason === "login_logged_in") {
		return { title: "Kirjautuminen onnistui", body: "Voit sulkea tämän ikkunan.", success: true };
	}
	if (reason === "timeout") {
		return {
			title: "Aika loppui",
			body: "Näkymä suljettiin. Pyydä agenttia avaamaan se tarvittaessa uudelleen.",
			success: false,
		};
	}
	if (reason.startsWith("login_")) {
		return {
			title: "Kirjautuminen keskeytyi",
			body: "Voit sulkea tämän ikkunan ja jatkaa agentin kanssa.",
			success: false,
		};
	}
	return null;
}
const PORT_READY_TIMEOUT_MS = 8_000;

function vncCommand(config: RemoteScreenConfig, passwordFile: string): string[] {
	return [
		"x11vnc",
		"-display",
		config.display,
		"-rfbport",
		String(config.vncPort),
		"-localhost",
		// Reconnects must work: the phone drops the socket while the user is in
		// the bank app approving the login.
		"-forever",
		// rm: makes x11vnc delete the plain-text file right after reading it.
		"-passwdfile",
		`rm:${passwordFile}`,
		"-nosel",
		"-noclipboard",
		"-nosetclipboard",
		"-noprimary",
		"-nosetprimary",
		"-noxdamage",
		"-quiet",
	];
}

function websockifyCommand(config: RemoteScreenConfig): string[] {
	return [
		"websockify",
		"--web",
		config.novncDir,
		`127.0.0.1:${config.wsPort}`,
		`127.0.0.1:${config.vncPort}`,
	];
}

export function createRemoteScreen(deps: RemoteScreenDeps) {
	type Session = {
		url: string;
		openedAt: number;
		ttlMs: number;
		procs: SpawnedProcess[];
		passwordFile: string;
		stopTicker: () => void;
	};
	let session: Session | null = null;
	// A closed session whose processes stay up briefly to show the outcome.
	let lingering: { procs: SpawnedProcess[]; passwordFile: string } | null = null;
	let opening: Promise<RemoteScreenStatus> | null = null;
	let lastCloseReason: string | null = null;
	let checking = false;

	function teardown(procs: SpawnedProcess[], passwordFile: string): void {
		for (const proc of procs) proc.kill();
		deps.removeFile(passwordFile);
	}

	function endLinger(): void {
		if (!lingering) return;
		teardown(lingering.procs, lingering.passwordFile);
		lingering = null;
	}

	function close(reason: string): void {
		if (!session) return;
		const current = session;
		session = null;
		lastCloseReason = reason;
		current.stopTicker();
		const message = messageFor(reason);
		logger.info(
			{
				reason,
				openSeconds: Math.round((deps.now() - current.openedAt) / 1000),
				lingerSeconds: message ? MESSAGE_LINGER_MS / 1000 : 0,
			},
			"Remote login screen closed",
		);
		if (!message) {
			teardown(current.procs, current.passwordFile);
			return;
		}
		const linger = { procs: current.procs, passwordFile: current.passwordFile };
		lingering = linger;
		void (async () => {
			let removeMessage: (() => Promise<void>) | null = null;
			try {
				removeMessage = await deps.showMessage(message);
			} catch (err) {
				logger.warn({ err }, "Could not show the remote screen outcome message");
			}
			deps.schedule(() => {
				// A reopen may already have torn this one down.
				if (lingering === linger) endLinger();
				void removeMessage?.();
			}, MESSAGE_LINGER_MS);
		})();
	}

	async function check(): Promise<void> {
		if (!session || checking) return;
		checking = true;
		try {
			if (deps.now() - session.openedAt > session.ttlMs) {
				close("timeout");
				return;
			}
			const phase = await deps.holdLogin();
			if (phase !== REQUIRED_PHASE) {
				close(`login_${phase}`);
				return;
			}
			// Background work (keepalive, auto-sync) opens its own tabs in the
			// same headed window; keep the login tab the one the human sees.
			await deps.bringLoginPageToFront();
		} catch (err) {
			logger.warn({ err }, "Remote login screen check failed");
		} finally {
			checking = false;
		}
	}

	async function doOpen(): Promise<RemoteScreenStatus> {
		// The previous screen's processes still hold the ports while its
		// outcome message lingers.
		endLinger();
		const phase = await deps.holdLogin();
		if (phase !== REQUIRED_PHASE) {
			throw new Error(
				`Remote screen is only opened while the login is in ${REQUIRED_PHASE} (now: ${phase}). ` +
					"Start the S-Etukortti login and submit the OTP first.",
			);
		}
		const config = deps.config();
		const password = generateVncPassword();
		const passwordFile = deps.writePasswordFile(password);
		const procs: SpawnedProcess[] = [];
		try {
			await deps.bringLoginPageToFront();
			procs.push(deps.spawn(vncCommand(config, passwordFile)));
			procs.push(deps.spawn(websockifyCommand(config)));
			const ready = await Promise.all([
				deps.waitForPort(config.vncPort, PORT_READY_TIMEOUT_MS),
				deps.waitForPort(config.wsPort, PORT_READY_TIMEOUT_MS),
			]);
			if (!ready.every(Boolean)) {
				throw new Error(
					`Remote screen did not start (x11vnc ready: ${ready[0]}, websockify ready: ${ready[1]}). ` +
						"Check that the Xvfb display is up and ports are free.",
				);
			}
		} catch (err) {
			teardown(procs, passwordFile);
			logger.warn({ err }, "Remote login screen failed to open");
			throw err;
		}

		const opened: Session = {
			url: buildViewerUrl(config.publicUrl, password),
			openedAt: deps.now(),
			ttlMs: config.ttlMs,
			procs,
			passwordFile,
			stopTicker: deps.startTicker(() => {
				void check();
			}),
		};
		session = opened;
		for (const [name, proc] of [
			["x11vnc", procs[0]],
			["websockify", procs[1]],
		] as const) {
			void proc?.exited.then((code) => {
				if (session !== opened) return;
				logger.warn({ name, code }, "Remote login screen process exited unexpectedly");
				close(`${name}_exited`);
			});
		}
		logger.info(
			{ display: config.display, ttlMinutes: Math.round(config.ttlMs / 60_000) },
			"Remote login screen opened",
		);
		return status();
	}

	// Single-flight: parallel tool calls must not race to bind the same ports
	// and leave the loser's processes running unsupervised.
	async function open(): Promise<RemoteScreenStatus> {
		if (session) return status();
		if (!opening) {
			opening = doOpen().finally(() => {
				opening = null;
			});
		}
		return opening;
	}

	function status(): RemoteScreenStatus {
		return {
			open: session !== null,
			url: session?.url ?? null,
			openedAt: session ? new Date(session.openedAt).toISOString() : null,
			expiresAt: session ? new Date(session.openedAt + session.ttlMs).toISOString() : null,
			lastCloseReason,
		};
	}

	return { open, close, status };
}

function configFromEnv(): RemoteScreenConfig {
	const display = process.env.DISPLAY;
	const publicUrl = process.env.S_ETUKORTTI_REMOTE_SCREEN_URL;
	if (!display || !publicUrl) {
		throw new Error(
			"Remote screen is not configured: needs DISPLAY (Xvfb) and S_ETUKORTTI_REMOTE_SCREEN_URL",
		);
	}
	const ttlMinutes = Number(process.env.S_ETUKORTTI_REMOTE_SCREEN_MINUTES ?? 15);
	return {
		display,
		vncPort: 5901,
		wsPort: 6080,
		publicUrl,
		novncDir: "/usr/share/novnc",
		ttlMs: (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 15) * 60_000,
	};
}

function writePasswordFile(password: string): string {
	const path = join(tmpdir(), `muona-vnc-${process.pid}-${Date.now()}`);
	writeFileSync(path, `${password}\n`, { mode: 0o600 });
	return path;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function messageHtml(message: ScreenMessage): string {
	return `<!doctype html><html lang="fi"><head><meta charset="utf-8"><title>${escapeHtml(message.title)}</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:sans-serif;background:${message.success ? "#0c893b" : "#3d3d3d"};color:#fff;text-align:center">
<div><h1 style="font-size:34px;margin:0 16px 16px">${escapeHtml(message.title)}</h1><p style="font-size:22px;margin:0 24px">${escapeHtml(message.body)}</p></div>
</body></html>`;
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>((resolve) => {
			const socket = createConnection({ host: "127.0.0.1", port });
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
		if (connected) return true;
		await Bun.sleep(250);
	}
	return false;
}

export const remoteScreen = createRemoteScreen({
	config: configFromEnv,
	spawn: (cmd) => {
		const [file, ...args] = cmd;
		if (!file) throw new Error("Empty command");
		// Own process group, killed as a whole: websockify forks a child per
		// connection that inherits the listening socket, and killing only the
		// parent left that child holding port 6080 (observed live).
		const proc = spawnProcess(file, args, { detached: true, stdio: "ignore" });
		const exited = new Promise<number>((resolve) => {
			proc.once("exit", (code) => resolve(code ?? -1));
			proc.once("error", (err) => {
				logger.warn({ err, file }, "Remote login screen process failed to start");
				resolve(-1);
			});
		});
		return {
			exited,
			kill: () => {
				if (proc.pid === undefined) return;
				try {
					// SIGKILL: x11vnc catches SIGTERM and then deadlocks in its
					// shutdown path (observed live), leaving the VNC port open.
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					// Group already gone.
				}
			},
		};
	},
	writePasswordFile,
	removeFile: (path) => rmSync(path, { force: true }),
	waitForPort,
	holdLogin: () => sGroup.login.holdForRemoteScreen(),
	// The raw context, not the login steps: the note is a local page that
	// never navigates, so it needs no IdP lease.
	showMessage: async (message) => {
		const ctx = await getContext();
		const page = await ctx.newPage();
		await page.setContent(messageHtml(message));
		await page.bringToFront();
		return async () => {
			await page.close().catch(() => {});
		};
	},
	schedule: (fn, ms) => {
		setTimeout(fn, ms);
	},
	bringLoginPageToFront: () => sGroup.login.bringToFront(),
	now: () => Date.now(),
	startTicker: (fn) => {
		const timer = setInterval(fn, 5_000);
		return () => clearInterval(timer);
	},
});
