// Background scheduler that periodically syncs the last two weeks of
// receipts without any user action, so the local database stays fresh
// between manual syncs. Runs on a 60-second tick, only actually syncing when
// enabled, not already running, past the configured interval, and inside the
// configured Helsinki-time-of-day window (to avoid syncing at odd hours).
//
// The decision logic (window checks, next-run computation, run/skip
// gating) is factored out into pure functions of explicit inputs so it can
// be unit-tested without real timers or a real syncReceipts call.

import * as z from "zod/v4";
import { formatHelsinkiDate, type HelsinkiDate } from "./date-range.ts";
import { logger } from "./logger.ts";
import { getSetting, setSetting } from "./store/settings.ts";
import { type SyncOptions, type SyncSummary, syncReceipts } from "./store/sync.ts";

export interface AutoSyncConfig {
	enabled: boolean;
	intervalMinutes: number;
	windowStartHour: number;
	windowEndHour: number;
}

export const DEFAULT_AUTO_SYNC_CONFIG: AutoSyncConfig = {
	enabled: true,
	intervalMinutes: 60,
	windowStartHour: 6,
	windowEndHour: 23,
};

const AutoSyncConfigSchema = z.object({
	enabled: z.boolean(),
	intervalMinutes: z.number(),
	windowStartHour: z.number(),
	windowEndHour: z.number(),
});

const SETTINGS_KEY = "autosync.config";

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

// Clamps into the allowed ranges (15-1440 minutes, 0-23 start hour, 1-24 end
// hour). Does not enforce windowStartHour < windowEndHour — callers that need
// that relationship (the configure_auto_sync tool) validate it up front.
export function clampAutoSyncConfig(
	partial: Partial<AutoSyncConfig>,
	base: AutoSyncConfig = DEFAULT_AUTO_SYNC_CONFIG,
): AutoSyncConfig {
	const merged = { ...base, ...partial };
	return {
		enabled: merged.enabled,
		intervalMinutes: clamp(merged.intervalMinutes, 15, 1440),
		windowStartHour: clamp(merged.windowStartHour, 0, 23),
		windowEndHour: clamp(merged.windowEndHour, 1, 24),
	};
}

export function getAutoSyncConfig(): AutoSyncConfig {
	const raw = getSetting(SETTINGS_KEY);
	if (raw === null) return DEFAULT_AUTO_SYNC_CONFIG;

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return DEFAULT_AUTO_SYNC_CONFIG;
	}

	const result = AutoSyncConfigSchema.safeParse(parsedJson);
	return result.success ? result.data : DEFAULT_AUTO_SYNC_CONFIG;
}

function persistAutoSyncConfig(config: AutoSyncConfig): void {
	setSetting(SETTINGS_KEY, JSON.stringify(config));
}

// --- Helsinki time-of-day window -------------------------------------------

function helsinkiDateParts(date: Date): HelsinkiDate {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Helsinki",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
	return { year: get("year"), month: get("month"), day: get("day") };
}

function helsinkiHour(date: Date): number {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/Helsinki",
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const hour = parts.find((p) => p.type === "hour")?.value;
	return hour === undefined ? 0 : Number(hour);
}

export function isWithinHelsinkiWindow(
	config: Pick<AutoSyncConfig, "windowStartHour" | "windowEndHour">,
	now: Date,
): boolean {
	const hour = helsinkiHour(now);
	return hour >= config.windowStartHour && hour < config.windowEndHour;
}

function shiftHelsinkiDate(date: HelsinkiDate, deltaDays: number): HelsinkiDate {
	const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + deltaDays));
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
	};
}

// Converts a Helsinki wall-clock date+time into the UTC instant it
// represents, correcting for the Europe/Helsinki UTC offset (which varies
// with DST) by iterating: format a guessed instant back into Helsinki wall
// time and nudge the guess by however far off it is. Converges in at most a
// couple of iterations since the offset only ever takes a couple of values.
function helsinkiWallClockToInstant(wall: HelsinkiDate & { hour: number }): Date {
	let guessMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, 0, 0);
	const wantedMs = guessMs;

	for (let i = 0; i < 4; i++) {
		const actualDate = helsinkiDateParts(new Date(guessMs));
		const actualHour = helsinkiHour(new Date(guessMs));
		const actualMs = Date.UTC(
			actualDate.year,
			actualDate.month - 1,
			actualDate.day,
			actualHour,
			0,
			0,
		);
		const diff = wantedMs - actualMs;
		if (diff === 0) break;
		guessMs += diff;
	}

	return new Date(guessMs);
}

// If `baseline` already falls inside the configured window, returns it
// unchanged. Otherwise returns the instant of the next window opening
// (windowStartHour:00 Helsinki time, same day if the window hasn't started
// yet today, otherwise the next day).
export function computeNextRunInWindowAt(baseline: Date, config: AutoSyncConfig): Date {
	if (isWithinHelsinkiWindow(config, baseline)) return baseline;

	const datePart = helsinkiDateParts(baseline);
	const hour = helsinkiHour(baseline);
	const targetDate = hour >= config.windowEndHour ? shiftHelsinkiDate(datePart, 1) : datePart;

	return helsinkiWallClockToInstant({ ...targetDate, hour: config.windowStartHour });
}

export function computeNextEligibleAt(now: Date, intervalMinutes: number): Date {
	return new Date(now.getTime() + intervalMinutes * 60_000);
}

// --- 14-day sync range -------------------------------------------------

// Pure, parameterized equivalent of date-range.ts's helsinkiToday()+range
// helpers: those always read the real system clock, which auto-sync's tests
// can't fake, so the Helsinki calendar-date computation is repeated here for
// an arbitrary instant. formatHelsinkiDate is reused as-is.
export function last14DayRange(now: Date): { startDate: string; endDate: string } {
	const today = helsinkiDateParts(now);
	const start = shiftHelsinkiDate(today, -13);
	return { startDate: formatHelsinkiDate(start), endDate: formatHelsinkiDate(today) };
}

// --- Run/skip decision ---------------------------------------------------

export type AutoSyncSkipReason =
	| "disabled"
	| "already-running"
	| "not-yet-eligible"
	| "outside-window";

export type AutoSyncDecision = { run: true } | { run: false; reason: AutoSyncSkipReason };

export interface AutoSyncDecisionState {
	running: boolean;
	nextEligibleAt: string | null;
}

export function shouldRunNow(
	config: AutoSyncConfig,
	state: AutoSyncDecisionState,
	now: Date,
): AutoSyncDecision {
	if (!config.enabled) return { run: false, reason: "disabled" };
	if (state.running) return { run: false, reason: "already-running" };
	if (state.nextEligibleAt !== null && now.getTime() < new Date(state.nextEligibleAt).getTime()) {
		return { run: false, reason: "not-yet-eligible" };
	}
	if (!isWithinHelsinkiWindow(config, now)) return { run: false, reason: "outside-window" };
	return { run: true };
}

// --- Attempting a sync -----------------------------------------------------

export interface AutoSyncLastRun {
	at: string;
	ok: boolean;
	summariesUpserted?: number;
	detailsFetched?: number;
	error?: string;
}

export type AutoSyncFn = (options: SyncOptions) => Promise<SyncSummary>;

// Runs one sync attempt over the last 14 days and turns the outcome into a
// lastRun record. Never throws: failures (including SessionExpiredError from
// a missing/expired login) are captured as `{ok: false, error}` so the
// caller can just record the result and wait for the next interval.
export async function runAutoSyncAttempt(params: {
	now: Date;
	syncFn: AutoSyncFn;
}): Promise<AutoSyncLastRun> {
	const { startDate, endDate } = last14DayRange(params.now);
	try {
		const summary = await params.syncFn({ startDate, endDate, fetchDelayMs: 400 });
		return {
			at: params.now.toISOString(),
			ok: true,
			summariesUpserted: summary.summariesUpserted,
			detailsFetched: summary.detailsFetched,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ err: error }, "Auto-sync attempt failed");
		return { at: params.now.toISOString(), ok: false, error: message };
	}
}

// --- Scheduler state & public API ------------------------------------------

export interface AutoSyncStatus {
	config: AutoSyncConfig;
	lastRun: AutoSyncLastRun | null;
	running: boolean;
	nextEligibleAt: string | null;
	nextRunInWindowAt: string;
}

interface RuntimeState {
	lastRun: AutoSyncLastRun | null;
	lastAttemptAt: string | null;
	nextEligibleAt: string | null;
	running: boolean;
}

const runtimeState: RuntimeState = {
	lastRun: null,
	lastAttemptAt: null,
	nextEligibleAt: null,
	running: false,
};

const TICK_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let activeSyncFn: AutoSyncFn = syncReceipts;
let nowFn: () => Date = () => new Date();

async function tick(): Promise<void> {
	const now = nowFn();
	const config = getAutoSyncConfig();
	const decision = shouldRunNow(config, runtimeState, now);
	if (!decision.run) return;

	runtimeState.running = true;
	runtimeState.lastAttemptAt = now.toISOString();
	try {
		runtimeState.lastRun = await runAutoSyncAttempt({ now, syncFn: activeSyncFn });
	} finally {
		runtimeState.running = false;
		runtimeState.nextEligibleAt = computeNextEligibleAt(now, config.intervalMinutes).toISOString();
	}
}

export interface StartAutoSyncOptions {
	syncFn?: AutoSyncFn;
	now?: () => Date;
}

// Idempotent: calling this more than once (e.g. across warmup retries) just
// keeps the existing timer running.
export function startAutoSync(options: StartAutoSyncOptions = {}): void {
	if (options.syncFn) activeSyncFn = options.syncFn;
	if (options.now) nowFn = options.now;
	if (timer !== null) return;

	timer = setInterval(() => {
		tick().catch((error) => {
			logger.error({ err: error }, "Auto-sync tick crashed unexpectedly");
		});
	}, TICK_INTERVAL_MS);
	timer.unref?.();
}

export function stopAutoSync(): void {
	if (timer !== null) {
		clearInterval(timer);
		timer = null;
	}
}

export function updateAutoSyncConfig(partial: Partial<AutoSyncConfig>): AutoSyncStatus {
	const clamped = clampAutoSyncConfig(partial, getAutoSyncConfig());
	persistAutoSyncConfig(clamped);
	return getAutoSyncStatus();
}

export function getAutoSyncStatus(now: Date = nowFn()): AutoSyncStatus {
	const config = getAutoSyncConfig();
	const baseline = runtimeState.nextEligibleAt ? new Date(runtimeState.nextEligibleAt) : now;
	return {
		config,
		lastRun: runtimeState.lastRun,
		running: runtimeState.running,
		nextEligibleAt: runtimeState.nextEligibleAt,
		nextRunInWindowAt: computeNextRunInWindowAt(baseline, config).toISOString(),
	};
}
