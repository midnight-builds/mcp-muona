import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { getAutoSyncConfig, getAutoSyncStatus, updateAutoSyncConfig } from "../auto-sync.ts";
import { resolveDbPath } from "../store/receipts-db.ts";
import { ok, run } from "./tool-result.ts";

export function registerAutoSyncTools(server: McpServer): void {
	server.registerTool(
		"configure_auto_sync",
		{
			description:
				"Configures the automatic background receipt sync (interval and allowed Helsinki-time " +
				"window, default 06-23). Manual syncs are always available via sync_receipts regardless " +
				"of this configuration.",
			inputSchema: z.object({
				enabled: z.boolean().optional().describe("Turn automatic background syncing on or off"),
				intervalMinutes: z
					.number()
					.int()
					.min(15)
					.max(1440)
					.optional()
					.describe("Minutes between sync attempts (15-1440)"),
				windowStartHour: z
					.number()
					.int()
					.min(0)
					.max(23)
					.optional()
					.describe("Earliest Helsinki-time hour (0-23) syncing is allowed to start"),
				windowEndHour: z
					.number()
					.int()
					.min(1)
					.max(24)
					.optional()
					.describe("Helsinki-time hour (1-24) after which syncing stops for the day"),
			}),
		},
		async (input) =>
			run("Error configuring auto-sync", async () => {
				const current = getAutoSyncConfig();
				const nextStart = input.windowStartHour ?? current.windowStartHour;
				const nextEnd = input.windowEndHour ?? current.windowEndHour;
				if (nextStart >= nextEnd) {
					throw new Error(
						`windowStartHour (${nextStart}) must be before windowEndHour (${nextEnd})`,
					);
				}
				return ok(updateAutoSyncConfig(input));
			}),
	);

	server.registerTool(
		"auto_sync_status",
		{
			description:
				"Reports when receipts were last fetched automatically, whether it succeeded, and when " +
				"the next automatic sync is due. See also s_etukortti_session_status for a broader " +
				"health check.",
			inputSchema: z.object({}),
		},
		async () =>
			run("Error fetching auto-sync status", async () =>
				ok({ ...getAutoSyncStatus(), dbPath: resolveDbPath() }),
			),
	);
}
