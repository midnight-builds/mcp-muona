// Local long-term purchase history. The S-Etukortti API only serves each
// receipt's raw text on demand and doesn't offer any cross-receipt search, so
// this mirrors fetched receipts into SQLite: once a receipt's raw text has
// been parsed and stored here, it's available for offline search without
// hitting the API (or a live login session) again.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod/v4";
import type { ReceiptSummary } from "../browser/s-etukortti.ts";
import { logger } from "../logger.ts";
import type { ParsedReceipt } from "../receipt-text.ts";

const SCHEMA_VERSION = 1;
// Detail parsing matches the API total exactly in practice; this just allows
// for float rounding noise, not for genuine parser drift.
const PARSER_MATCH_TOLERANCE = 0.005;

export interface StoredReceiptItem {
	lineNo: number;
	name: string;
	total: number;
	quantity: number | null;
	unit: string | null;
	unitPrice: number | null;
	discount: number | null;
	notes: string[];
}

export interface StoredReceipt {
	receiptId: string;
	placeOfBusinessCode: string;
	placeOfBusinessName: string;
	transactionStart: string;
	totalAmount: number;
	rawText: string | null;
	parsedTotal: number | null;
	parserOk: boolean | null;
	detailFetchedAt: string | null;
	createdAt: string;
	items: StoredReceiptItem[];
}

export interface SearchItemsQuery {
	nameLike?: string;
	startDate?: string;
	endDate?: string;
	store?: string;
	limit?: number;
}

export interface SearchItemResult {
	receiptId: string;
	store: string;
	transactionStart: string;
	name: string;
	total: number;
	quantity: number | null;
	unit: string | null;
	unitPrice: number | null;
	discount: number | null;
	notes: string[];
}

export interface ReceiptStats {
	receiptCount: number;
	itemCount: number;
	earliestDate: string | null;
	latestDate: string | null;
	totalAmountSum: number;
	parserMismatchCount: number;
}

const ReceiptRowSchema = z.object({
	receipt_id: z.string(),
	place_of_business_code: z.string(),
	place_of_business_name: z.string(),
	transaction_start: z.string(),
	total_amount: z.number(),
	raw_text: z.string().nullable(),
	parsed_total: z.number().nullable(),
	parser_ok: z.number().nullable(),
	detail_fetched_at: z.string().nullable(),
	created_at: z.string(),
});

const ItemRowSchema = z.object({
	receipt_id: z.string(),
	line_no: z.number(),
	name: z.string(),
	total: z.number(),
	quantity: z.number().nullable(),
	unit: z.string().nullable(),
	unit_price: z.number().nullable(),
	discount: z.number().nullable(),
	notes: z.string().nullable(),
});

const SearchRowSchema = ItemRowSchema.extend({
	place_of_business_name: z.string(),
	transaction_start: z.string(),
});

const StatsRowSchema = z.object({
	receipt_count: z.number(),
	total_amount_sum: z.number().nullable(),
	earliest_date: z.string().nullable(),
	latest_date: z.string().nullable(),
	// SUM() over zero rows yields NULL, not 0.
	parser_mismatch_count: z.number().nullable(),
});

const ItemCountRowSchema = z.object({ item_count: z.number() });

const ReceiptIdRowSchema = z.object({ receipt_id: z.string() });

function parseNotes(raw: string | null): string[] {
	if (raw === null) return [];
	const parsed: unknown = JSON.parse(raw);
	return z.array(z.string()).parse(parsed);
}

function toStoredItem(row: z.infer<typeof ItemRowSchema>): StoredReceiptItem {
	return {
		lineNo: row.line_no,
		name: row.name,
		total: row.total,
		quantity: row.quantity,
		unit: row.unit,
		unitPrice: row.unit_price,
		discount: row.discount,
		notes: parseNotes(row.notes),
	};
}

function toParserOk(value: number | null): boolean | null {
	if (value === null) return null;
	return value !== 0;
}

function defaultDbPath(): string {
	return join(import.meta.dirname, "..", "..", "data", "receipts.sqlite");
}

export function resolveDbPath(): string {
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
	instance.exec("PRAGMA foreign_keys = ON;");
	instance.exec(`
		CREATE TABLE IF NOT EXISTS receipts (
			receipt_id TEXT PRIMARY KEY,
			place_of_business_code TEXT NOT NULL,
			place_of_business_name TEXT NOT NULL,
			transaction_start TEXT NOT NULL,
			total_amount REAL NOT NULL,
			raw_text TEXT,
			parsed_total REAL,
			parser_ok INTEGER,
			detail_fetched_at TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
	`);
	instance.exec(`
		CREATE TABLE IF NOT EXISTS receipt_items (
			receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id) ON DELETE CASCADE,
			line_no INTEGER NOT NULL,
			name TEXT NOT NULL,
			total REAL NOT NULL,
			quantity REAL,
			unit TEXT,
			unit_price REAL,
			discount REAL,
			notes TEXT,
			PRIMARY KEY (receipt_id, line_no)
		);
	`);
	instance.exec(
		"CREATE INDEX IF NOT EXISTS idx_receipts_transaction_start ON receipts(transaction_start);",
	);
	instance.exec("CREATE INDEX IF NOT EXISTS idx_receipt_items_name ON receipt_items(name);");
	instance.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);

	logger.info({ path }, "Opened receipts database");
	db = instance;
	return instance;
}

export function closeDb(): void {
	db?.close();
	db = null;
}

export function upsertReceiptSummary(summary: ReceiptSummary): void {
	getDb()
		.query(
			`INSERT INTO receipts (receipt_id, place_of_business_code, place_of_business_name, transaction_start, total_amount)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(receipt_id) DO UPDATE SET
				place_of_business_code = excluded.place_of_business_code,
				place_of_business_name = excluded.place_of_business_name,
				transaction_start = excluded.transaction_start,
				total_amount = excluded.total_amount`,
		)
		.run(
			summary.receiptId,
			summary.placeOfBusinessCode,
			summary.placeOfBusinessName,
			summary.transactionStart,
			summary.totalAmount,
		);
}

export function saveReceiptDetail(receiptId: string, rawText: string, parsed: ParsedReceipt): void {
	const instance = getDb();

	const existing = instance
		.query("SELECT total_amount FROM receipts WHERE receipt_id = ?")
		.get(receiptId);
	if (existing === null) {
		throw new Error(`Cannot save detail for unknown receipt ${receiptId}`);
	}
	const totalAmount = z.object({ total_amount: z.number() }).parse(existing).total_amount;

	const parserOk =
		parsed.total !== null && Math.abs(parsed.total - totalAmount) < PARSER_MATCH_TOLERANCE ? 1 : 0;

	const save = instance.transaction(() => {
		instance.query("DELETE FROM receipt_items WHERE receipt_id = ?").run(receiptId);

		const insertItem = instance.query(
			`INSERT INTO receipt_items (receipt_id, line_no, name, total, quantity, unit, unit_price, discount, notes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		parsed.items.forEach((item, index) => {
			const params: SQLQueryBindings[] = [
				receiptId,
				index,
				item.name,
				item.total,
				item.quantity ?? null,
				item.unit ?? null,
				item.unitPrice ?? null,
				item.discount ?? null,
				item.notes.length > 0 ? JSON.stringify(item.notes) : null,
			];
			insertItem.run(...params);
		});

		instance
			.query(
				`UPDATE receipts
				 SET raw_text = ?, parsed_total = ?, parser_ok = ?,
					 detail_fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
				 WHERE receipt_id = ?`,
			)
			.run(rawText, parsed.total, parserOk, receiptId);
	});
	save();
}

export function getReceipt(receiptId: string): StoredReceipt | null {
	const instance = getDb();
	const row = instance.query("SELECT * FROM receipts WHERE receipt_id = ?").get(receiptId);
	if (row === null) return null;
	const receipt = ReceiptRowSchema.parse(row);

	const itemRows = instance
		.query("SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY line_no")
		.all(receiptId);
	const items = itemRows.map((itemRow) => toStoredItem(ItemRowSchema.parse(itemRow)));

	return {
		receiptId: receipt.receipt_id,
		placeOfBusinessCode: receipt.place_of_business_code,
		placeOfBusinessName: receipt.place_of_business_name,
		transactionStart: receipt.transaction_start,
		totalAmount: receipt.total_amount,
		rawText: receipt.raw_text,
		parsedTotal: receipt.parsed_total,
		parserOk: toParserOk(receipt.parser_ok),
		detailFetchedAt: receipt.detail_fetched_at,
		createdAt: receipt.created_at,
		items,
	};
}

// `firstSeenSince` limits to receipts whose summary was first stored at or
// after that instant; created_at and toISOString() share one UTC format, so
// they compare as strings.
export function listReceiptsMissingDetail(firstSeenSince?: Date): string[] {
	const rows =
		firstSeenSince === undefined
			? getDb().query("SELECT receipt_id FROM receipts WHERE raw_text IS NULL").all()
			: getDb()
					.query("SELECT receipt_id FROM receipts WHERE raw_text IS NULL AND created_at >= ?")
					.all(firstSeenSince.toISOString());
	return rows.map((row) => ReceiptIdRowSchema.parse(row).receipt_id);
}

// Re-runs the parser over every receipt that already has raw text and rewrites
// its items and parser_ok. Used after parser improvements so stored history
// benefits without re-fetching from the API. The parser is injected to keep
// this module free of a dependency on receipt-text.
export function reparseStored(parse: (rawText: string) => ParsedReceipt): {
	reparsed: number;
	parserOk: number;
} {
	const instance = getDb();
	const rows = instance
		.query("SELECT receipt_id, raw_text FROM receipts WHERE raw_text IS NOT NULL")
		.all();
	const parsed = z.array(z.object({ receipt_id: z.string(), raw_text: z.string() })).parse(rows);

	let parserOk = 0;
	for (const row of parsed) {
		const result = parse(row.raw_text);
		saveReceiptDetail(row.receipt_id, row.raw_text, result);
		if (getReceipt(row.receipt_id)?.parserOk) parserOk++;
	}
	return { reparsed: parsed.length, parserOk };
}

export function searchItems(query: SearchItemsQuery): SearchItemResult[] {
	const conditions: string[] = [];
	const params: SQLQueryBindings[] = [];

	if (query.nameLike) {
		conditions.push("LOWER(ri.name) LIKE LOWER(?)");
		params.push(`%${query.nameLike}%`);
	}
	if (query.store) {
		conditions.push("LOWER(r.place_of_business_name) LIKE LOWER(?)");
		params.push(`%${query.store}%`);
	}
	if (query.startDate) {
		conditions.push("r.transaction_start >= ?");
		params.push(query.startDate);
	}
	if (query.endDate) {
		// Exclusive upper bound one day past endDate: since transaction_start
		// is an ISO timestamp, its date prefix always sorts below the next
		// calendar day regardless of the time-of-day or UTC offset suffix.
		conditions.push("r.transaction_start < ?");
		params.push(nextDay(query.endDate));
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = query.limit ?? 100;
	params.push(limit);

	const rows = getDb()
		.query(
			`SELECT ri.*, r.place_of_business_name, r.transaction_start
			 FROM receipt_items ri
			 JOIN receipts r ON r.receipt_id = ri.receipt_id
			 ${where}
			 ORDER BY r.transaction_start DESC, ri.line_no ASC
			 LIMIT ?`,
		)
		.all(...params);

	return rows.map((row) => {
		const parsed = SearchRowSchema.parse(row);
		return {
			...toStoredItem(parsed),
			receiptId: parsed.receipt_id,
			store: parsed.place_of_business_name,
			transactionStart: parsed.transaction_start,
		};
	});
}

function nextDay(date: string): string {
	const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match?.[1] || !match[2] || !match[3]) {
		throw new Error(`Invalid date: ${date}`);
	}
	const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
	const y = next.getUTCFullYear();
	const m = String(next.getUTCMonth() + 1).padStart(2, "0");
	const d = String(next.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function getStats(): ReceiptStats {
	const instance = getDb();
	const statsRow = instance
		.query(
			`SELECT
				COUNT(*) AS receipt_count,
				SUM(total_amount) AS total_amount_sum,
				MIN(transaction_start) AS earliest_date,
				MAX(transaction_start) AS latest_date,
				SUM(CASE WHEN parser_ok = 0 THEN 1 ELSE 0 END) AS parser_mismatch_count
			 FROM receipts`,
		)
		.get();
	const stats = StatsRowSchema.parse(statsRow);

	const itemCountRow = instance.query("SELECT COUNT(*) AS item_count FROM receipt_items").get();
	const itemCount = ItemCountRowSchema.parse(itemCountRow).item_count;

	return {
		receiptCount: stats.receipt_count,
		itemCount,
		earliestDate: stats.earliest_date,
		latestDate: stats.latest_date,
		totalAmountSum: stats.total_amount_sum ?? 0,
		parserMismatchCount: stats.parser_mismatch_count ?? 0,
	};
}
