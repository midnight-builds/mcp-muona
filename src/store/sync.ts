// Pulls receipts from the S-Etukortti API into the local database. The API
// serves receipt lists per calendar month, so a requested range is split into
// month-sized chunks; receipt detail (raw text + parsed line items) is only
// fetched for receipts that don't already have it stored, so re-running a
// sync over an overlapping range is cheap.

import * as z from "zod/v4";
import type { ReceiptDetail, ReceiptSummary } from "../browser/s-etukortti.ts";
import * as sEtukortti from "../browser/s-etukortti.ts";
import { logger } from "../logger.ts";
import { parseReceiptText } from "../receipt-text.ts";
import {
	listReceiptsMissingDetail,
	saveReceiptDetail,
	upsertReceiptSummary,
} from "./receipts-db.ts";

export const SyncSummarySchema = z.object({
	months: z.array(z.string()),
	summariesUpserted: z.number().int(),
	detailsFetched: z.number().int(),
	parserMismatches: z.array(
		z.object({
			receiptId: z.string(),
			apiTotal: z.number(),
			parsedTotal: z.number().nullable(),
		}),
	),
	errors: z.array(z.object({ receiptId: z.string(), message: z.string() })),
});

export type SyncSummary = z.infer<typeof SyncSummarySchema>;

export interface SyncOptions {
	startDate: string;
	endDate: string;
	fetchDelayMs?: number;
	fetchReceipts?: (startDate: string, endDate: string) => Promise<ReceiptSummary[]>;
	fetchReceipt?: (receiptId: string) => Promise<ReceiptDetail>;
}

interface MonthChunk {
	start: string;
	end: string;
	month: string;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function parseISODate(date: string): { year: number; month: number; day: number } {
	const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match?.[1] || !match[2] || !match[3]) {
		throw new Error(`Invalid date: ${date}`);
	}
	return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function lastDayOfMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Splits [startDate, endDate] (inclusive, YYYY-MM-DD) into per-calendar-month
// chunks clipped to the requested range, e.g. 2026-05-15..2026-07-21 becomes
// [2026-05-15..05-31, 2026-06-01..06-30, 2026-07-01..07-21].
function monthChunks(startDate: string, endDate: string): MonthChunk[] {
	const start = parseISODate(startDate);
	const end = parseISODate(endDate);
	if (startDate > endDate) {
		throw new Error(`startDate ${startDate} is after endDate ${endDate}`);
	}

	const chunks: MonthChunk[] = [];
	let year = start.year;
	let month = start.month;

	for (;;) {
		const isFirstChunk = year === start.year && month === start.month;
		const isLastChunk = year === end.year && month === end.month;
		const chunkStartDay = isFirstChunk ? start.day : 1;
		const chunkEndDay = isLastChunk ? end.day : lastDayOfMonth(year, month);

		chunks.push({
			start: `${year}-${pad(month)}-${pad(chunkStartDay)}`,
			end: `${year}-${pad(month)}-${pad(chunkEndDay)}`,
			month: `${year}-${pad(month)}`,
		});

		if (isLastChunk) break;
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}

	return chunks;
}

const PARSER_MATCH_TOLERANCE = 0.005;

export async function syncReceipts(options: SyncOptions): Promise<SyncSummary> {
	const {
		startDate,
		endDate,
		fetchDelayMs = 400,
		fetchReceipts = sEtukortti.fetchReceipts,
		fetchReceipt = sEtukortti.fetchReceipt,
	} = options;

	const chunks = monthChunks(startDate, endDate);
	const months: string[] = [];
	const seenReceiptIds = new Set<string>();
	let summariesUpserted = 0;

	for (const chunk of chunks) {
		months.push(chunk.month);
		const summaries = await fetchReceipts(chunk.start, chunk.end);
		for (const summary of summaries) {
			upsertReceiptSummary(summary);
			seenReceiptIds.add(summary.receiptId);
			summariesUpserted += 1;
		}
	}

	const missingDetailIds = new Set(listReceiptsMissingDetail());
	const toFetch = [...seenReceiptIds].filter((id) => missingDetailIds.has(id));

	const parserMismatches: SyncSummary["parserMismatches"] = [];
	const errors: SyncSummary["errors"] = [];
	let detailsFetched = 0;

	for (const [index, receiptId] of toFetch.entries()) {
		if (index > 0 && fetchDelayMs > 0) {
			await Bun.sleep(fetchDelayMs);
		}
		try {
			const detail = await fetchReceipt(receiptId);
			const parsed = parseReceiptText(detail.receiptData);
			saveReceiptDetail(receiptId, detail.receiptData, parsed);
			detailsFetched += 1;

			const mismatch =
				parsed.total === null ||
				Math.abs(parsed.total - detail.totalAmount) >= PARSER_MATCH_TOLERANCE;
			if (mismatch) {
				parserMismatches.push({
					receiptId,
					apiTotal: detail.totalAmount,
					parsedTotal: parsed.total,
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error({ err: error, receiptId }, "Failed to sync receipt detail");
			errors.push({ receiptId, message });
		}
	}

	return SyncSummarySchema.parse({
		months,
		summariesUpserted,
		detailsFetched,
		parserMismatches,
		errors,
	});
}
