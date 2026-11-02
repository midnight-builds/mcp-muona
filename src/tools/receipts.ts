import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { getAutoSyncStatus } from "../auto-sync.ts";
import * as sEtukortti from "../browser/s-etukortti.ts";
import { sGroup } from "../browser/s-group/index.ts";
import { parseReceiptText } from "../receipt-text.ts";
import { getLoginAges } from "../store/login-history.ts";
import { READ } from "./annotations.ts";
import { ok, run } from "./tool-result.ts";

const DATE = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.describe("Date in YYYY-MM-DD format");

const PERIOD = z
	.string()
	.regex(/^\d{4}-\d{2}$/, "Use YYYY-MM")
	.describe("Month in YYYY-MM format");

function helsinkiToday(): { year: number; month: number; day: number } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Helsinki",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date());
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
	return { year: get("year"), month: get("month"), day: get("day") };
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function currentMonthRange(): { startDate: string; endDate: string; period: string } {
	const { year, month } = helsinkiToday();
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return {
		startDate: `${year}-${pad(month)}-01`,
		endDate: `${year}-${pad(month)}-${pad(lastDay)}`,
		period: `${year}-${pad(month)}`,
	};
}

export function registerReceiptTools(server: McpServer): void {
	server.registerTool(
		"get_receipts",
		{
			title: "S-Etukortti: list receipts",
			annotations: READ,
			description:
				"List S-Etukortti purchase receipts for the logged-in S-ryhmä member. " +
				"Returns receipt IDs, store names, timestamps and totals. " +
				"Defaults to the current calendar month. Use get_receipt for full line items. " +
				"Requires an active session (see s_etukortti_session_status if this fails).",
			inputSchema: z.object({
				startDate: DATE.optional().describe("First day to include (default: 1st of current month)"),
				endDate: DATE.optional().describe(
					"Last day to include (default: last day of current month)",
				),
			}),
		},
		async ({ startDate, endDate }) =>
			run("Error fetching receipts", async () => {
				const defaults = currentMonthRange();
				const receipts = await sEtukortti.fetchReceipts(
					startDate ?? defaults.startDate,
					endDate ?? defaults.endDate,
				);
				return ok({
					startDate: startDate ?? defaults.startDate,
					endDate: endDate ?? defaults.endDate,
					count: receipts.length,
					receipts,
				});
			}),
	);

	server.registerTool(
		"get_receipt",
		{
			title: "S-Etukortti: one receipt",
			annotations: READ,
			description:
				"Fetch one S-Etukortti receipt by receiptId (from get_receipts). Returns the raw " +
				"printed receipt text plus parsed line items (name, price, quantity, discounts).",
			inputSchema: z.object({
				receiptId: z
					.string()
					.min(1)
					.describe("Receipt ID from get_receipts, e.g. '123456_1111111'"),
			}),
		},
		async ({ receiptId }) =>
			run("Error fetching receipt", async () => {
				const receipt = await sEtukortti.fetchReceipt(receiptId);
				const parsed = parseReceiptText(receipt.receiptData);
				return ok({
					receiptId: receipt.receiptId,
					store: receipt.placeOfBusinessName,
					transactionStart: receipt.transactionStart,
					totalAmount: receipt.totalAmount,
					items: parsed.items,
					parsedTotal: parsed.total,
					rawText: receipt.receiptData,
				});
			}),
	);

	server.registerTool(
		"get_bonus_summary",
		{
			title: "S-Etukortti: monthly bonus summary",
			annotations: READ,
			description:
				"S-Etukortti bonus summary for one month: bonus percentage, benefit amounts, " +
				"purchase totals, amount needed for the next bonus level, and the per-purchase list. " +
				"Includes the co-op's bonus level table.",
			inputSchema: z.object({
				period: PERIOD.optional().describe("Month to summarize (default: current month)"),
			}),
		},
		async ({ period }) =>
			run("Error fetching bonus summary", async () => {
				const resolved = period ?? currentMonthRange().period;
				const [purchases, levels] = await Promise.all([
					sEtukortti.fetchBenefitsPurchases(resolved),
					sEtukortti.fetchBonusLevels(),
				]);
				return ok({ period: resolved, ...purchases, bonusLevels: levels });
			}),
	);

	server.registerTool(
		"get_bonus_status",
		{
			title: "S-Etukortti: current bonus status",
			annotations: READ,
			description:
				"Quick check of the current month's S-Etukortti bonus status: bonus percentage, " +
				"purchase totals, benefit amount so far, and how much more is needed for the next " +
				"bonus level. Lighter than get_bonus_summary (no per-purchase list or level table).",
			inputSchema: z.object({}),
		},
		async () =>
			run("Error fetching bonus status", async () => {
				const period = currentMonthRange().period;
				const purchases = await sEtukortti.fetchBenefitsPurchases(period);
				return ok({
					period,
					bonusPercent: purchases.periodBonusPercent,
					purchasesTotal: purchases.periodPurchasesTotal,
					bonusPurchasesTotal: purchases.periodBonusPurchasesTotal,
					benefitAmount: purchases.periodBenefitAmount,
					purchasesForNextLevel: purchases.periodPurchasesForNextLevel,
				});
			}),
	);

	server.registerTool(
		"get_benefit_totals",
		{
			title: "S-Etukortti: benefit totals",
			annotations: READ,
			description:
				"S-Etukortti benefit totals over a range of months: accumulated bonus, fuel " +
				"discounts, surplus returns and total benefits. Months are YYYY-MM.",
			inputSchema: z.object({
				start: PERIOD.describe("First month of the range, e.g. '2025-07'"),
				end: PERIOD.describe("Last month of the range, e.g. '2026-06'"),
			}),
		},
		async ({ start, end }) =>
			run("Error fetching benefit totals", async () => {
				const totals = await sEtukortti.fetchBenefitsTotals(start, end);
				return ok(totals);
			}),
	);

	server.registerTool(
		"get_discounts",
		{
			title: "S-Etukortti: campaign discounts",
			annotations: READ,
			description:
				"S-Etukortti campaign discounts (kampanjaedut) received in a date range, per month " +
				"and per purchase.",
			inputSchema: z.object({
				type: z.enum(["month", "year"]).default("month").describe("Aggregation granularity"),
				startDate: DATE.optional().describe("Range start (default: 1st of current month)"),
				endDate: DATE.optional().describe("Range end (default: today)"),
			}),
		},
		async ({ type, startDate, endDate }) =>
			run("Error fetching discounts", async () => {
				const { year, month, day } = helsinkiToday();
				const discounts = await sEtukortti.fetchDiscounts(
					type,
					startDate ?? `${year}-${pad(month)}-01`,
					endDate ?? `${year}-${pad(month)}-${pad(day)}`,
				);
				return ok(discounts);
			}),
	);

	server.registerTool(
		"s_etukortti_session_status",
		{
			title: "S-Etukortti: session status",
			annotations: READ,
			description:
				"Cheap health check for the S-Etukortti login session — call this periodically " +
				"(e.g. once a day) to verify the session is still alive, not only when a receipt tool " +
				"fails. Only start the login flow with the human user (s_etukortti_login_start) when " +
				"this reports loggedIn: false; never try to log in or request one-time codes yourself " +
				"outside that flow. Like the receipt tools, this check renews an expired session by " +
				"itself; if the S-tunnus SSO has expired too, that can email the user one code.",
			inputSchema: z.object({}),
		},
		async () =>
			run("Error checking session", async () => {
				const [status, login] = await Promise.all([sGroup.probe(), sGroup.login.state()]);
				const report = sGroup.report();
				const autoSyncStatus = getAutoSyncStatus();
				return ok({
					...status,
					login,
					keepalive: report.keepalive,
					autoRelogin: report.autoRelogin,
					appSession: report.appSession,
					idpLease: report.idpLease,
					loginHistory: getLoginAges(),
					autoSync: {
						lastRun: autoSyncStatus.lastRun,
						nextRunInWindowAt: autoSyncStatus.nextRunInWindowAt,
						enabled: autoSyncStatus.config.enabled,
					},
				});
			}),
	);
}
