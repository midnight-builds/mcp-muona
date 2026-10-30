// S-Etukortti data fetchers. Authentication (app session, CSRF token,
// relogin, keepalive) lives entirely in the S-group session module; these
// only name an endpoint and its schema.

import * as z from "zod/v4";
import { logger } from "../logger.ts";
import { sGroup } from "./s-group/index.ts";

function envelope<T extends z.ZodType>(data: T) {
	return z.object({
		data,
		status: z.string(),
		errors: z.unknown().nullable(),
	});
}

export const ReceiptSummarySchema = z.object({
	receiptId: z.string(),
	placeOfBusinessCode: z.string(),
	placeOfBusinessName: z.string(),
	transactionStart: z.string(),
	totalAmount: z.number(),
});

export const ReceiptsResponseSchema = envelope(
	z.object({ receipts: z.array(ReceiptSummarySchema) }),
);

export const ReceiptDetailSchema = ReceiptSummarySchema.extend({
	receiptData: z.string(),
});

export const ReceiptDetailResponseSchema = envelope(z.object({ receipt: ReceiptDetailSchema }));

export const BonusPurchaseSchema = z.object({
	purchaseDate: z.string(),
	purchaseTotal: z.number(),
	isDoubleBonus: z.boolean(),
	businessInformation: z.object({ costCenterName: z.string() }),
});

export const BenefitsPurchasesSchema = z.object({
	periodId: z.string(),
	periodBonusPercent: z.number().nullable(),
	periodBonusBenefitAmount: z.number().nullable(),
	periodFuelFillUpBonusBenefitAmount: z.number().nullable(),
	periodBenefitAmount: z.number().nullable(),
	periodBonusPurchasesTotal: z.number().nullable(),
	periodPurchasesTotal: z.number().nullable(),
	periodPurchasesForNextLevel: z.number().nullable(),
	bonusPurchases: z.array(BonusPurchaseSchema),
});

export const BenefitsPurchasesResponseSchema = envelope(BenefitsPurchasesSchema);

export const BenefitsTotalsSchema = z.object({
	periodIds: z.array(z.string()),
	bonus: z.object({ bonusPurchasesTotal: z.number(), bonusTotal: z.number() }),
	fuelFillUps: z.object({
		fuelFillUpPurchasesTotal: z.number(),
		fuelFillUpBonusTotal: z.number(),
	}),
	surplusTotal: z.number().nullable(),
	interestTotal: z.number().nullable(),
	totalBenefits: z.number(),
});

export const BenefitsTotalsResponseSchema = envelope(BenefitsTotalsSchema);

export const BonusLevelsSchema = z.object({
	companyName: z.string(),
	levels: z.array(z.object({ percentage: z.number(), purchasesMin: z.number() })),
});

export const BonusLevelsResponseSchema = envelope(BonusLevelsSchema);

export const DiscountPurchaseSchema = z.object({
	pobName: z.string(),
	transactionStart: z.string(),
	discountAmount: z.number(),
	purchaseAmount: z.number(),
});

export const DiscountsSchema = z.object({
	discountMonths: z.array(
		z.object({
			month: z.string(),
			discountAmount: z.number().nullable(),
			discountPurchases: z.array(DiscountPurchaseSchema),
		}),
	),
	discountTotals: z.object({ discountTotal: z.number().nullable() }),
});

export const DiscountsResponseSchema = envelope(DiscountsSchema);

export type ReceiptSummary = z.infer<typeof ReceiptSummarySchema>;
export type ReceiptDetail = z.infer<typeof ReceiptDetailSchema>;
export type BenefitsPurchases = z.infer<typeof BenefitsPurchasesSchema>;
export type BenefitsTotals = z.infer<typeof BenefitsTotalsSchema>;
export type BonusLevels = z.infer<typeof BonusLevelsSchema>;
export type Discounts = z.infer<typeof DiscountsSchema>;

export async function fetchReceipts(startDate: string, endDate: string): Promise<ReceiptSummary[]> {
	logger.info({ startDate, endDate }, "Fetching S-Etukortti receipts");
	const parsed = await sGroup.get(
		"/api/v1/receipts",
		{ startDate, endDate },
		ReceiptsResponseSchema,
	);
	logger.info({ count: parsed.data.receipts.length }, "S-Etukortti receipts fetched");
	return parsed.data.receipts;
}

export async function fetchReceipt(receiptId: string): Promise<ReceiptDetail> {
	logger.info({ receiptId }, "Fetching S-Etukortti receipt detail");
	const parsed = await sGroup.get(
		`/api/v1/receipts/${encodeURIComponent(receiptId)}`,
		{},
		ReceiptDetailResponseSchema,
	);
	return parsed.data.receipt;
}

export async function fetchBenefitsPurchases(period: string): Promise<BenefitsPurchases> {
	logger.info({ period }, "Fetching S-Etukortti benefits purchases");
	const parsed = await sGroup.get(
		"/api/v1/benefits-purchases",
		{ period },
		BenefitsPurchasesResponseSchema,
	);
	return parsed.data;
}

export async function fetchBenefitsTotals(start: string, end: string): Promise<BenefitsTotals> {
	logger.info({ start, end }, "Fetching S-Etukortti benefits totals");
	const parsed = await sGroup.get(
		"/api/v1/benefits-purchases/totals",
		{ start, end },
		BenefitsTotalsResponseSchema,
	);
	return parsed.data;
}

export async function fetchBonusLevels(): Promise<BonusLevels> {
	const parsed = await sGroup.get("/api/v1/bonus-levels", {}, BonusLevelsResponseSchema);
	return parsed.data;
}

export async function fetchDiscounts(
	type: "month" | "year",
	startDate: string,
	endDate: string,
): Promise<Discounts> {
	logger.info({ type, startDate, endDate }, "Fetching S-Etukortti discounts");
	const parsed = await sGroup.get(
		"/api/v1/discounts",
		{ type, startDate, endDate },
		DiscountsResponseSchema,
	);
	return parsed.data;
}
