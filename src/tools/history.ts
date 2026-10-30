import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { defaultSyncRange } from "../date-range.ts";
import { getStats, resolveDbPath, searchItems } from "../store/receipts-db.ts";
import { syncReceipts } from "../store/sync.ts";
import { ok, run } from "./tool-result.ts";

const DATE = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.describe("Date in YYYY-MM-DD format");

export function registerHistoryTools(server: McpServer): void {
	server.registerTool(
		"sync_receipts",
		{
			description:
				"Download receipts from S-Etukortti into the local purchase-history database " +
				"(fetches summaries for the date range, then full line-item detail for any receipts " +
				"not already stored). Requires a valid S-Etukortti session — see " +
				"s_etukortti_session_status if this fails. Defaults to the last ~2 months.",
			inputSchema: z.object({
				startDate: DATE.optional().describe(
					"First day to sync (default: 1st of the month two months ago)",
				),
				endDate: DATE.optional().describe("Last day to sync (default: today)"),
			}),
		},
		async ({ startDate, endDate }) =>
			run("Error syncing receipts", async () => {
				const defaults = defaultSyncRange();
				const summary = await syncReceipts({
					startDate: startDate ?? defaults.startDate,
					endDate: endDate ?? defaults.endDate,
				});
				return ok(summary);
			}),
	);

	server.registerTool(
		"search_purchases",
		{
			description:
				"Search the local purchase-history database (no network access) for previously " +
				"purchased items by name, date range, and/or store. Use sync_receipts first if the " +
				"database is empty or stale (see purchase_history_stats).",
			inputSchema: z.object({
				query: z.string().optional().describe("Case-insensitive substring match against item name"),
				startDate: DATE.optional().describe("Only include purchases on or after this date"),
				endDate: DATE.optional().describe("Only include purchases on or before this date"),
				store: z
					.string()
					.optional()
					.describe("Case-insensitive substring match against store name"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.default(50)
					.describe("Maximum number of items to return (default 50, max 200)"),
			}),
		},
		async ({ query, startDate, endDate, store, limit }) =>
			run("Error searching purchase history", async () => {
				const items = searchItems({ nameLike: query, startDate, endDate, store, limit });
				return ok({ count: items.length, items });
			}),
	);

	server.registerTool(
		"purchase_history_stats",
		{
			description:
				"Summary of the local long-term purchase-history database: receipt and item counts, " +
				"the covered date range, and how many receipts failed to parse cleanly. This database " +
				"is built by sync_receipts and searched by search_purchases; call this to check whether " +
				"it's populated and up to date before relying on it.",
			inputSchema: z.object({}),
		},
		async () =>
			run("Error reading purchase history stats", async () => {
				return ok({ ...getStats(), dbPath: resolveDbPath() });
			}),
	);
}
