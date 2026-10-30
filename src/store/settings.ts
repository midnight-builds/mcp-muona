// Small persisted key-value store for app settings (e.g. auto-sync config),
// sharing the receipts SQLite file but through its own connection: this
// module is written to independently of the receipts-db connection, and WAL
// mode lets both coexist safely. SQLite can still return a brief "database
// is locked" error under concurrent writes, so writes are retried once.

import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod/v4";

function defaultDbPath(): string {
	return join(import.meta.dirname, "..", "..", "data", "receipts.sqlite");
}

function resolveDbPath(): string {
	return process.env.MUONA_DB_PATH ?? defaultDbPath();
}

let db: Database | null = null;

function getDb(): Database {
	if (db) return db;

	const path = resolveDbPath();
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}

	const instance = new Database(path, { create: true });
	instance.exec("PRAGMA journal_mode = WAL;");
	instance.exec(`
		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	db = instance;
	return instance;
}

export function closeSettingsDb(): void {
	db?.close();
	db = null;
}

const BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

function isBusyError(error: unknown): boolean {
	return error instanceof SQLiteError && error.code !== undefined && BUSY_CODES.has(error.code);
}

// Retries a write once after a brief pause if SQLite reports the database as
// busy/locked, which can happen momentarily under concurrent writers even in
// WAL mode.
function withBusyRetry<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (!isBusyError(error)) throw error;
		Bun.sleepSync(50);
		return fn();
	}
}

const SettingRowSchema = z.object({ value: z.string() });

export function getSetting(key: string): string | null {
	const row = withBusyRetry(() =>
		getDb().query("SELECT value FROM settings WHERE key = ?").get(key),
	);
	if (row === null) return null;
	return SettingRowSchema.parse(row).value;
}

export function setSetting(key: string, value: string): void {
	withBusyRetry(() => {
		getDb()
			.query(
				`INSERT INTO settings (key, value) VALUES (?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
			.run(key, value);
	});
}

export function deleteSetting(key: string): void {
	withBusyRetry(() => {
		getDb().query("DELETE FROM settings WHERE key = ?").run(key);
	});
}
