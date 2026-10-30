import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReceiptSummary } from "../browser/s-etukortti.ts";
import type { ParsedReceipt } from "../receipt-text.ts";
import {
	closeDb,
	getReceipt,
	getStats,
	listReceiptsMissingDetail,
	saveReceiptDetail,
	searchItems,
	upsertReceiptSummary,
} from "./receipts-db.ts";

let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `muona-test-${randomUUID()}.sqlite`);
	process.env.MUONA_DB_PATH = dbPath;
});

afterEach(() => {
	closeDb();
	for (const suffix of ["", "-wal", "-shm"]) {
		const path = `${dbPath}${suffix}`;
		if (existsSync(path)) rmSync(path);
	}
	delete process.env.MUONA_DB_PATH;
});

function summary(overrides: Partial<ReceiptSummary> = {}): ReceiptSummary {
	return {
		receiptId: "123456_1",
		placeOfBusinessCode: "584100000",
		placeOfBusinessName: "S-market Testilä",
		transactionStart: "2026-07-20T21:06:38+03:00",
		totalAmount: 15.56,
		...overrides,
	};
}

const MATCHING_PARSED: ParsedReceipt = {
	items: [
		{
			name: "BANAANI CHIQUITA",
			total: 1.56,
			quantity: 0.784,
			unit: "KG",
			unitPrice: 1.99,
			notes: [],
		},
		{ name: "MAITO", total: 14.0, notes: ["OMISTAJAETU"] },
	],
	total: 15.56,
	storeHeader: "S-market Testilä",
	unparsedLines: [],
};

const MISMATCHED_PARSED: ParsedReceipt = {
	items: [{ name: "BANAANI CHIQUITA", total: 1.56, notes: [] }],
	total: 1.56,
	storeHeader: "S-market Testilä",
	unparsedLines: [],
};

describe("upsertReceiptSummary", () => {
	test("inserts a new receipt", () => {
		upsertReceiptSummary(summary());
		const receipt = getReceipt("123456_1");
		expect(receipt?.receiptId).toBe("123456_1");
		expect(receipt?.totalAmount).toBe(15.56);
		expect(receipt?.rawText).toBeNull();
	});

	test("is idempotent: upserting the same receipt twice yields one row", () => {
		upsertReceiptSummary(summary());
		upsertReceiptSummary(summary({ totalAmount: 20.0 }));
		const stats = getStats();
		expect(stats.receiptCount).toBe(1);
		expect(getReceipt("123456_1")?.totalAmount).toBe(20.0);
	});

	test("re-upserting a summary does not clobber stored detail", () => {
		upsertReceiptSummary(summary());
		saveReceiptDetail("123456_1", "raw text", MATCHING_PARSED);
		upsertReceiptSummary(summary());
		const receipt = getReceipt("123456_1");
		expect(receipt?.rawText).toBe("raw text");
		expect(receipt?.items).toHaveLength(2);
	});
});

describe("saveReceiptDetail", () => {
	test("marks parser_ok true when parsed total matches the API total", () => {
		upsertReceiptSummary(summary());
		saveReceiptDetail("123456_1", "raw text", MATCHING_PARSED);
		const receipt = getReceipt("123456_1");
		expect(receipt?.parserOk).toBe(true);
		expect(receipt?.parsedTotal).toBe(15.56);
		expect(receipt?.detailFetchedAt).not.toBeNull();
		expect(receipt?.items.map((i) => i.name)).toEqual(["BANAANI CHIQUITA", "MAITO"]);
		expect(receipt?.items[0]?.unit).toBe("KG");
		expect(receipt?.items[1]?.notes).toEqual(["OMISTAJAETU"]);
	});

	test("marks parser_ok false when parsed total diverges from the API total", () => {
		upsertReceiptSummary(summary());
		saveReceiptDetail("123456_1", "raw text", MISMATCHED_PARSED);
		const receipt = getReceipt("123456_1");
		expect(receipt?.parserOk).toBe(false);
		expect(receipt?.parsedTotal).toBe(1.56);
	});

	test("marks parser_ok false when the parser found no total at all", () => {
		upsertReceiptSummary(summary());
		saveReceiptDetail("123456_1", "raw text", { ...MISMATCHED_PARSED, total: null });
		expect(getReceipt("123456_1")?.parserOk).toBe(false);
	});

	test("replaces items on re-save rather than appending", () => {
		upsertReceiptSummary(summary());
		saveReceiptDetail("123456_1", "raw text", MATCHING_PARSED);
		saveReceiptDetail("123456_1", "raw text v2", MISMATCHED_PARSED);
		const receipt = getReceipt("123456_1");
		expect(receipt?.items).toHaveLength(1);
		expect(receipt?.rawText).toBe("raw text v2");
	});

	test("removes the receipt from listReceiptsMissingDetail once saved", () => {
		upsertReceiptSummary(summary());
		upsertReceiptSummary(summary({ receiptId: "123456_2" }));
		expect(listReceiptsMissingDetail().sort()).toEqual(["123456_1", "123456_2"]);
		saveReceiptDetail("123456_1", "raw text", MATCHING_PARSED);
		expect(listReceiptsMissingDetail()).toEqual(["123456_2"]);
	});
});

describe("getReceipt", () => {
	test("returns null for an unknown receipt", () => {
		expect(getReceipt("does-not-exist")).toBeNull();
	});
});

describe("searchItems", () => {
	beforeEach(() => {
		upsertReceiptSummary(
			summary({
				receiptId: "123456_1",
				transactionStart: "2026-05-10T10:00:00+03:00",
				placeOfBusinessName: "S-market Testilä",
			}),
		);
		saveReceiptDetail("123456_1", "raw 1", {
			items: [{ name: "BANAANI CHIQUITA", total: 1.56, notes: [] }],
			total: 1.56,
			storeHeader: null,
			unparsedLines: [],
		});

		upsertReceiptSummary(
			summary({
				receiptId: "123456_2",
				transactionStart: "2026-06-15T10:00:00+03:00",
				placeOfBusinessName: "Prisma Kotka",
			}),
		);
		saveReceiptDetail("123456_2", "raw 2", {
			items: [{ name: "MAITO KEVYT", total: 1.29, notes: [] }],
			total: 1.29,
			storeHeader: null,
			unparsedLines: [],
		});
	});

	test("filters by nameLike, case-insensitively", () => {
		const results = searchItems({ nameLike: "banaani" });
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe("BANAANI CHIQUITA");
	});

	test("filters by date range", () => {
		const results = searchItems({ startDate: "2026-06-01", endDate: "2026-06-30" });
		expect(results).toHaveLength(1);
		expect(results[0]?.receiptId).toBe("123456_2");
	});

	test("filters by store, case-insensitively", () => {
		const results = searchItems({ store: "prisma" });
		expect(results).toHaveLength(1);
		expect(results[0]?.store).toBe("Prisma Kotka");
	});

	test("returns everything when no filters are given", () => {
		expect(searchItems({})).toHaveLength(2);
	});

	test("respects limit", () => {
		expect(searchItems({ limit: 1 })).toHaveLength(1);
	});
});

describe("getStats", () => {
	test("reports zeroes on an empty database", () => {
		const stats = getStats();
		expect(stats.receiptCount).toBe(0);
		expect(stats.itemCount).toBe(0);
		expect(stats.earliestDate).toBeNull();
		expect(stats.latestDate).toBeNull();
		expect(stats.totalAmountSum).toBe(0);
		expect(stats.parserMismatchCount).toBe(0);
	});

	test("aggregates counts, totals, date range and mismatches", () => {
		upsertReceiptSummary(
			summary({
				receiptId: "123456_1",
				transactionStart: "2026-05-10T10:00:00+03:00",
				totalAmount: 10,
			}),
		);
		upsertReceiptSummary(
			summary({
				receiptId: "123456_2",
				transactionStart: "2026-07-20T10:00:00+03:00",
				totalAmount: 5,
			}),
		);
		saveReceiptDetail("123456_1", "raw", MATCHING_PARSED); // parsed total 15.56 != 10 -> mismatch
		saveReceiptDetail("123456_2", "raw", {
			items: [{ name: "X", total: 5, notes: [] }],
			total: 5,
			storeHeader: null,
			unparsedLines: [],
		});

		const stats = getStats();
		expect(stats.receiptCount).toBe(2);
		expect(stats.itemCount).toBe(3);
		expect(stats.earliestDate).toBe("2026-05-10T10:00:00+03:00");
		expect(stats.latestDate).toBe("2026-07-20T10:00:00+03:00");
		expect(stats.totalAmountSum).toBe(15);
		expect(stats.parserMismatchCount).toBe(1);
	});
});
