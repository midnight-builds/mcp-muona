// Settings-DB adapter for the session store. Every access is best-effort: a
// broken settings DB may disable automatic relogins but must never break a
// data fetch or a login in progress.

import { logger } from "../../logger.ts";
import {
	getLoginAges,
	type LoginAges,
	type LoginKind,
	recordLogin,
} from "../../store/login-history.ts";
import { deleteSetting, getSetting, setSetting } from "../../store/settings.ts";
import type { SessionStore } from "./ports.ts";

export const SAVED_EMAIL_SETTING_KEY = "login.email";
// Persisted: held only in memory, every service restart re-armed relogin and
// mailed a new one-time code.
export const RELOGIN_BLOCK_SETTING_KEY = "login.autoReloginBlocked";

export function getSavedEmail(): string | null {
	try {
		return getSetting(SAVED_EMAIL_SETTING_KEY);
	} catch (err) {
		logger.warn({ err }, "Could not read saved login email");
		return null;
	}
}

export function saveEmail(email: string): void {
	try {
		setSetting(SAVED_EMAIL_SETTING_KEY, email);
	} catch (err) {
		logger.warn({ err }, "Could not save login email for relogin");
	}
}

export function getReloginBlock(): string | null {
	try {
		return getSetting(RELOGIN_BLOCK_SETTING_KEY);
	} catch (err) {
		logger.warn({ err }, "Could not read the relogin block");
		return null;
	}
}

export function setReloginBlock(reason: string): void {
	try {
		setSetting(RELOGIN_BLOCK_SETTING_KEY, reason);
	} catch (err) {
		logger.warn({ err }, "Could not persist the relogin block");
	}
}

export function clearReloginBlock(): void {
	try {
		if (getSetting(RELOGIN_BLOCK_SETTING_KEY) === null) return;
		deleteSetting(RELOGIN_BLOCK_SETTING_KEY);
		logger.info("Relogin block cleared after a completed login");
	} catch (err) {
		logger.warn({ err }, "Could not clear the relogin block");
	}
}

export function safeLoginAges(): LoginAges | null {
	try {
		return getLoginAges();
	} catch (err) {
		logger.warn({ err }, "Could not read S-Etukortti login history");
		return null;
	}
}

function safeRecordLogin(kind: LoginKind, nowMs: number): LoginAges | null {
	try {
		return recordLogin(kind, nowMs);
	} catch (err) {
		logger.warn({ err }, "Could not record S-Etukortti login lifetime");
		return null;
	}
}

export const settingsSessionStore: SessionStore = {
	getReloginBlock,
	setReloginBlock,
	clearReloginBlock,
	getSavedEmail,
	loginAges: safeLoginAges,
	saveEmail,
	recordLogin: safeRecordLogin,
};
