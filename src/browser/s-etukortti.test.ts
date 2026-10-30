import { describe, expect, test } from "bun:test";
import {
	BenefitsPurchasesResponseSchema,
	BenefitsTotalsResponseSchema,
	BonusLevelsResponseSchema,
	DiscountsResponseSchema,
	ReceiptDetailResponseSchema,
	ReceiptsResponseSchema,
} from "./s-etukortti.ts";
import { parseScreenSize } from "./s-group/playwright.ts";

// Fixtures mirror the real api.s-etukortti.fi envelope and field shapes
// (captured from a sanitized HAR), with synthetic values.

describe("S-Etukortti API schemas", () => {
	test("receipts list", () => {
		const parsed = ReceiptsResponseSchema.parse({
			data: {
				receipts: [
					{
						receiptId: "123456_1111111",
						placeOfBusinessCode: "584100000",
						placeOfBusinessName: "S-market Testilä",
						transactionStart: "2026-07-20T21:06:38+03:00",
						totalAmount: 15.56,
					},
					{
						receiptId: "0510000_4906e243-29e7-45de-9c40-000000000000",
						placeOfBusinessCode: "pobmnevaaaaaaa",
						placeOfBusinessName: "ABC-lataus Testi",
						transactionStart: "2026-07-18T11:31:05.027+03:00",
						totalAmount: 3.43,
					},
				],
			},
			status: "OK",
			correlationId: "c52e8b1d-0000-0000-0000-000000000000",
			errors: null,
		});
		expect(parsed.data.receipts).toHaveLength(2);
		expect(parsed.data.receipts[0]?.totalAmount).toBe(15.56);
	});

	test("receipt detail includes receiptData text", () => {
		const parsed = ReceiptDetailResponseSchema.parse({
			data: {
				receipt: {
					receiptId: "123456_1111111",
					placeOfBusinessCode: "584100000",
					placeOfBusinessName: "S-market Testilä",
					transactionStart: "2026-07-20T21:06:38+03:00",
					totalAmount: 15.56,
					receiptData: "\n   TESTI\n------\nYHTEENSÄ  15,56\n",
				},
			},
			status: "OK",
			errors: null,
		});
		expect(parsed.data.receipt.receiptData).toContain("YHTEENSÄ");
	});

	test("benefits purchases tolerates extra fields and null percents", () => {
		const parsed = BenefitsPurchasesResponseSchema.parse({
			data: {
				periodId: "2026-07",
				periodBonusPercent: 5.0,
				periodBonusBenefitAmount: 36.65,
				periodFuelFillUpBonusBenefitAmount: 4.89,
				periodBenefitAmount: 41.54,
				periodBonusPurchasesTotal: 733.03,
				periodPurchasesTotal: 929.9,
				periodPurchasesForNextLevel: 0.0,
				coopCapitalInterestAmount: null,
				surplusReturnAmount: null,
				bonusPurchases: [
					{
						purchaseDate: "2026-07-02T18:09:33+03:00",
						purchaseTotal: 54.14,
						isDoubleBonus: false,
						isPaymentMethodBenefit: false,
						businessInformation: { costCenterName: "PRISMA TESTI KASSAOSASTO", chainId: "02" },
					},
				],
			},
			status: "OK",
			errors: null,
		});
		expect(parsed.data.bonusPurchases[0]?.purchaseTotal).toBe(54.14);
	});

	test("benefits totals", () => {
		const parsed = BenefitsTotalsResponseSchema.parse({
			data: {
				periodIds: ["2025-07", "2025-08"],
				bonus: { bonusPurchasesTotal: 13427.36, bonusTotal: 667.47 },
				fuelFillUps: { fuelFillUpPurchasesTotal: 701.55, fuelFillUpBonusTotal: 19.16 },
				paymentMethodBenefit: { paymentMethodBenefitTotal: 0.62 },
				interestTotal: 0.0,
				surplusTotal: 153.86,
				totalBenefits: 841.11,
			},
			status: "OK",
			errors: null,
		});
		expect(parsed.data.totalBenefits).toBe(841.11);
	});

	test("bonus levels", () => {
		const parsed = BonusLevelsResponseSchema.parse({
			data: {
				companyName: "EEKOO",
				levels: [
					{ percentage: 0.0, purchasesMin: 0.0 },
					{ percentage: 5.0, purchasesMin: 900.0 },
				],
			},
			status: "OK",
			errors: null,
		});
		expect(parsed.data.levels).toHaveLength(2);
	});

	test("discounts", () => {
		const parsed = DiscountsResponseSchema.parse({
			data: {
				dataBarring: false,
				discountMonths: [
					{
						month: "2026-07",
						discountAmount: 5.12,
						staffDiscountAmount: null,
						discountPurchases: [
							{
								purchaseId: "1784570798000:X:584100000:1:1:1111111",
								storeId: "584100000",
								pobId: "584100000",
								pobName: "S-market Testilä",
								transactionStart: "2026-07-20T21:06:38+03:00",
								discountAmount: -0.98,
								staffDiscountAmount: null,
								purchaseAmount: 15.56,
							},
						],
					},
				],
				discountTotals: { discountTotal: 5.12, staffDiscountTotal: null },
			},
			status: "OK",
			errors: null,
		});
		expect(parsed.data.discountMonths[0]?.discountPurchases[0]?.discountAmount).toBe(-0.98);
	});

	test("rejects a receipts payload with missing fields", () => {
		const result = ReceiptsResponseSchema.safeParse({
			data: { receipts: [{ receiptId: "x" }] },
			status: "OK",
			errors: null,
		});
		expect(result.success).toBe(false);
	});
});

describe("parseScreenSize", () => {
	test("parses WIDTHxHEIGHT", () => {
		expect(parseScreenSize("480x960")).toEqual({ width: 480, height: 960 });
	});

	test("rejects missing or malformed values", () => {
		expect(parseScreenSize(undefined)).toBeNull();
		expect(parseScreenSize("")).toBeNull();
		expect(parseScreenSize("480")).toBeNull();
		expect(parseScreenSize("0x960")).toBeNull();
		expect(parseScreenSize("abcxdef")).toBeNull();
	});
});
