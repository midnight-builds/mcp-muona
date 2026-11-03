import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReceiptDetail, ReceiptSummary } from "../browser/s-etukortti.ts";
import { closeDb, getReceipt } from "./receipts-db.ts";
import { closeSettingsDb } from "./settings.ts";
import { syncReceipts } from "./sync.ts";
import { getSyncCoverage } from "./sync-coverage.ts";

let dbPath: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `muona-sync-test-${randomUUID()}.sqlite`);
	process.env.MUONA_DB_PATH = dbPath;
});

afterEach(() => {
	closeDb();
	closeSettingsDb();
	for (const suffix of ["", "-wal", "-shm"]) {
		const path = `${dbPath}${suffix}`;
		if (existsSync(path)) rmSync(path);
	}
	delete process.env.MUONA_DB_PATH;
});

// Realistic S-market POS printout text, modeled on the fixture in
// src/receipt-text.test.ts (starred item lines, weighed item, YHTEENSÄ total).
function receiptText(total: number): string {
	return [
		"   S-MARKET TESTILÄ",
		"------------------------------------------",
		"*BANAANI CHIQUITA                     1,56 *",
		"  0,784 KG          1,99 €/KG",
		`*MAITO KEVYT                           ${total.toFixed(2).replace(".", ",")} *`,
		"------------------------------------------",
		`YHTEENSÄ                            ${total.toFixed(2).replace(".", ",")}`,
	].join("\n");
}

function makeSummary(
	receiptId: string,
	transactionStart: string,
	totalAmount: number,
): ReceiptSummary {
	return {
		receiptId,
		placeOfBusinessCode: "584100000",
		placeOfBusinessName: "S-market Testilä",
		transactionStart,
		totalAmount,
	};
}

function makeDetail(summary: ReceiptSummary, itemTotal: number): ReceiptDetail {
	return { ...summary, receiptData: receiptText(itemTotal) };
}

describe("syncReceipts month chunking", () => {
	test("splits the requested range into one fetchReceipts call per calendar month", async () => {
		const calls: Array<{ startDate: string; endDate: string }> = [];
		const summary = await syncReceipts({
			startDate: "2026-05-15",
			endDate: "2026-07-21",
			fetchDelayMs: 0,
			fetchReceipts: async (startDate, endDate) => {
				calls.push({ startDate, endDate });
				return [];
			},
			fetchReceipt: async (receiptId) => {
				throw new Error(`unexpected fetchReceipt(${receiptId})`);
			},
		});

		expect(calls).toEqual([
			{ startDate: "2026-05-15", endDate: "2026-05-31" },
			{ startDate: "2026-06-01", endDate: "2026-06-30" },
			{ startDate: "2026-07-01", endDate: "2026-07-21" },
		]);
		expect(summary.months).toEqual(["2026-05", "2026-06", "2026-07"]);
	});
});

describe("syncReceipts", () => {
	test("upserts summaries and fetches detail only for receipts missing it", async () => {
		const summaries = [
			makeSummary("123456_1", "2026-07-05T10:00:00+03:00", 3.98),
			makeSummary("123456_2", "2026-07-10T10:00:00+03:00", 3.98),
		];
		const fetchedReceiptIds: string[] = [];

		const result = await syncReceipts({
			startDate: "2026-07-01",
			endDate: "2026-07-21",
			fetchDelayMs: 0,
			fetchReceipts: async () => summaries,
			fetchReceipt: async (receiptId) => {
				fetchedReceiptIds.push(receiptId);
				const summary = summaries.find((s) => s.receiptId === receiptId);
				if (!summary) throw new Error("unknown receipt");
				return makeDetail(summary, 3.98);
			},
		});

		expect(result.summariesUpserted).toBe(2);
		expect(result.detailsFetched).toBe(2);
		expect(fetchedReceiptIds.sort()).toEqual(["123456_1", "123456_2"]);
		expect(result.parserMismatches).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(getReceipt("123456_1")?.parserOk).toBe(true);

		// Second run over the same range: summaries are re-upserted, but no
		// detail fetch is needed since both receipts already have raw text.
		let secondRunDetailCalls = 0;
		const second = await syncReceipts({
			startDate: "2026-07-01",
			endDate: "2026-07-21",
			fetchDelayMs: 0,
			fetchReceipts: async () => summaries,
			fetchReceipt: async (receiptId) => {
				secondRunDetailCalls += 1;
				const summary = summaries.find((s) => s.receiptId === receiptId);
				if (!summary) throw new Error("unknown receipt");
				return makeDetail(summary, 3.98);
			},
		});

		expect(second.summariesUpserted).toBe(2);
		expect(second.detailsFetched).toBe(0);
		expect(secondRunDetailCalls).toBe(0);
	});

	test("reports a parser mismatch when the parsed total diverges from the API total", async () => {
		const summary = makeSummary("123456_9", "2026-07-05T10:00:00+03:00", 999.99);

		const result = await syncReceipts({
			startDate: "2026-07-01",
			endDate: "2026-07-21",
			fetchDelayMs: 0,
			fetchReceipts: async () => [summary],
			fetchReceipt: async () => makeDetail(summary, 3.98), // receiptData totals 3.98, not 999.99
		});

		expect(result.parserMismatches).toEqual([
			{ receiptId: "123456_9", apiTotal: 999.99, parsedTotal: 3.98 },
		]);
		expect(getReceipt("123456_9")?.parserOk).toBe(false);
	});

	test("collects a per-receipt error instead of aborting the whole run", async () => {
		const ok = makeSummary("123456_1", "2026-07-05T10:00:00+03:00", 3.98);
		const broken = makeSummary("123456_2", "2026-07-10T10:00:00+03:00", 3.98);

		const result = await syncReceipts({
			startDate: "2026-07-01",
			endDate: "2026-07-21",
			fetchDelayMs: 0,
			fetchReceipts: async () => [ok, broken],
			fetchReceipt: async (receiptId) => {
				if (receiptId === "123456_2") throw new Error("network boom");
				return makeDetail(ok, 3.98);
			},
		});

		expect(result.detailsFetched).toBe(1);
		expect(result.errors).toEqual([{ receiptId: "123456_2", message: "network boom" }]);
		expect(getReceipt("123456_1")?.rawText).not.toBeNull();
		expect(getReceipt("123456_2")?.rawText).toBeNull();
	});

	test("rejects when startDate is after endDate", async () => {
		await expect(
			syncReceipts({
				startDate: "2026-07-21",
				endDate: "2026-07-01",
				fetchReceipts: async () => [],
				fetchReceipt: async () => {
					throw new Error("unused");
				},
			}),
		).rejects.toThrow();
	});
});

describe("syncReceipts coverage", () => {
	test("a clean run up to today records the covered day", async () => {
		await syncReceipts({
			startDate: "2026-11-01",
			endDate: "2026-11-03",
			today: "2026-11-03",
			fetchDelayMs: 0,
			fetchReceipts: async () => [],
			fetchReceipt: async (receiptId) => {
				throw new Error(`unexpected fetchReceipt(${receiptId})`);
			},
		});
		expect(getSyncCoverage()?.through).toBe("2026-11-03");
	});

	test("a failed receipt detail does not hold coverage back", async () => {
		const summary = makeSummary("123456_9", "2026-11-02T10:00:00+02:00", 3.98);
		await syncReceipts({
			startDate: "2026-11-01",
			endDate: "2026-11-03",
			today: "2026-11-03",
			fetchDelayMs: 0,
			fetchReceipts: async () => [summary],
			fetchReceipt: async () => {
				throw new Error("HTTP 502");
			},
		});
		expect(getSyncCoverage()?.through).toBe("2026-11-03");
	});

	test("a recent receipt whose detail failed is retried by a later run outside its range", async () => {
		const failed = makeSummary("123456_9", "2026-10-28T10:00:00+02:00", 3.98);
		await syncReceipts({
			startDate: "2026-10-28",
			endDate: "2026-10-28",
			today: "2026-10-28",
			fetchDelayMs: 0,
			fetchReceipts: async () => [failed],
			fetchReceipt: async () => {
				throw new Error("HTTP 502");
			},
		});

		const retried: string[] = [];
		const result = await syncReceipts({
			startDate: "2026-11-02",
			endDate: "2026-11-03",
			today: "2026-11-03",
			fetchDelayMs: 0,
			fetchReceipts: async () => [],
			fetchReceipt: async (receiptId) => {
				retried.push(receiptId);
				return makeDetail(failed, 3.98);
			},
		});
		expect(retried).toEqual(["123456_9"]);
		expect(result.detailsFetched).toBe(1);
	});

	test("a receipt first seen more than 14 days ago is left to an explicit backfill", async () => {
		const old = makeSummary("123456_8", "2026-10-01T10:00:00+03:00", 3.98);
		await syncReceipts({
			startDate: "2026-10-01",
			endDate: "2026-10-01",
			today: "2026-10-01",
			fetchDelayMs: 0,
			fetchReceipts: async () => [old],
			fetchReceipt: async () => {
				throw new Error("HTTP 502");
			},
		});

		const retried: string[] = [];
		await syncReceipts({
			startDate: "2026-11-02",
			endDate: "2026-11-03",
			today: "2026-11-03",
			now: new Date(Date.now() + 15 * 86_400_000),
			fetchDelayMs: 0,
			fetchReceipts: async () => [],
			fetchReceipt: async (receiptId) => {
				retried.push(receiptId);
				return makeDetail(old, 3.98);
			},
		});
		expect(retried).toEqual([]);
	});

	test("an old receipt first seen after an outage still gets retries though coverage moves on", async () => {
		const old = makeSummary("123456_6", "2026-10-10T10:00:00+03:00", 3.98);
		await syncReceipts({
			startDate: "2026-10-09",
			endDate: "2026-11-03",
			today: "2026-11-03",
			fetchDelayMs: 0,
			fetchReceipts: async (startDate) => (startDate.startsWith("2026-10") ? [old] : []),
			fetchReceipt: async () => {
				throw new Error("HTTP 502");
			},
		});
		expect(getSyncCoverage()?.through).toBe("2026-11-03");

		const retried: string[] = [];
		await syncReceipts({
			startDate: "2026-11-02",
			endDate: "2026-11-03",
			today: "2026-11-03",
			fetchDelayMs: 0,
			fetchReceipts: async () => [],
			fetchReceipt: async (receiptId) => {
				retried.push(receiptId);
				return makeDetail(old, 3.98);
			},
		});
		expect(retried).toEqual(["123456_6"]);
	});

	test("an existing coverage advances past a run with a failed detail", async () => {
		await syncReceipts({
			startDate: "2026-11-01",
			endDate: "2026-11-02",
			today: "2026-11-02",
			fetchDelayMs: 0,
			fetchReceipts: async () => [],
			fetchReceipt: async (receiptId) => {
				throw new Error(`unexpected fetchReceipt(${receiptId})`);
			},
		});
		await syncReceipts({
			startDate: "2026-11-01",
			endDate: "2026-11-03",
			today: "2026-11-03",
			fetchDelayMs: 0,
			fetchReceipts: async () => [makeSummary("123456_7", "2026-11-03T09:00:00+02:00", 3.98)],
			fetchReceipt: async () => {
				throw new Error("HTTP 502");
			},
		});
		expect(getSyncCoverage()?.through).toBe("2026-11-03");
	});

	test("a failing summary fetch records nothing", async () => {
		await expect(
			syncReceipts({
				startDate: "2026-11-01",
				endDate: "2026-11-03",
				today: "2026-11-03",
				fetchDelayMs: 0,
				fetchReceipts: async () => {
					throw new Error("HTTP 401");
				},
				fetchReceipt: async (receiptId) => {
					throw new Error(`unexpected fetchReceipt(${receiptId})`);
				},
			}),
		).rejects.toThrow("HTTP 401");
		expect(getSyncCoverage()).toBeNull();
	});
});
