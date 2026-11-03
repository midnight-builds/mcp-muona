// CLI wrapper around syncReceipts (see `bun run sync`). Fetches receipt
// summaries and details from the S-Etukortti API into the local database
// (see src/store/receipts-db.ts) and prints a human-readable summary.
//
// Usage: bun run scripts/sync-receipts.ts [--start YYYY-MM-DD] [--end YYYY-MM-DD]
// Without dates: from the day before the last successfully synced day through
// today, or from the 1st of the month two months ago when nothing is synced
// yet (Europe/Helsinki). A missing --start or --end falls back to the latter.

import { defaultSyncRange, helsinkiTodayDate } from "../src/date-range.ts";
import { logger } from "../src/logger.ts";
import { closeDb } from "../src/store/receipts-db.ts";
import { syncReceipts } from "../src/store/sync.ts";
import { resolveManualSyncRange } from "../src/store/sync-coverage.ts";

const say = (msg: string) => process.stdout.write(`${msg}\n`);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv: string[]): { startDate?: string; endDate?: string } {
	const result: { startDate?: string; endDate?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--start") result.startDate = argv[++i];
		else if (arg === "--end") result.endDate = argv[++i];
	}
	return result;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const today = helsinkiTodayDate();
	const { startDate, endDate, basis } = resolveManualSyncRange(args, today, defaultSyncRange());

	if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
		process.stderr.write(
			"Usage: bun run scripts/sync-receipts.ts [--start YYYY-MM-DD] [--end YYYY-MM-DD]\n",
		);
		process.exit(1);
	}

	logger.info({ startDate, endDate, basis }, "Starting receipt sync");
	const summary = await syncReceipts({ startDate, endDate, today });

	say(`Range: ${startDate}..${endDate}, ${basis} (${summary.months.join(", ")})`);
	say(`Summaries upserted: ${summary.summariesUpserted}`);
	say(`Details fetched: ${summary.detailsFetched}`);

	if (summary.parserMismatches.length > 0) {
		say(`Parser mismatches: ${summary.parserMismatches.length}`);
		for (const mismatch of summary.parserMismatches) {
			say(
				`  - ${mismatch.receiptId}: api=${mismatch.apiTotal} parsed=${mismatch.parsedTotal ?? "null"}`,
			);
		}
	} else {
		say("Parser mismatches: 0");
	}

	if (summary.errors.length > 0) {
		say(`Errors: ${summary.errors.length}`);
		for (const err of summary.errors) {
			say(`  - ${err.receiptId}: ${err.message}`);
		}
	} else {
		say("Errors: 0");
	}

	closeDb();
	process.exit(summary.errors.length > 0 || summary.parserMismatches.length > 0 ? 1 : 0);
}

await main();
