// Re-runs the receipt-text parser over every stored receipt and rewrites its
// items / parser_ok, without re-fetching from the API. Run this after improving
// src/receipt-text.ts so existing history benefits from the better parsing.
//
// Usage: bun run reparse

import { logger } from "../src/logger.ts";
import { parseReceiptText } from "../src/receipt-text.ts";
import { closeDb, getStats, reparseStored } from "../src/store/receipts-db.ts";

const say = (msg: string) => process.stdout.write(`${msg}\n`);

logger.info("Re-parsing stored receipts");
const result = reparseStored(parseReceiptText);
const stats = getStats();

say(`Re-parsed: ${result.reparsed}`);
say(`Parser OK: ${result.parserOk}`);
say(`Parser mismatches (by receipt total): ${stats.parserMismatchCount}`);
say(`Receipts in DB: ${stats.receiptCount}, items: ${stats.itemCount}`);

closeDb();
process.exit(0);
