import { describe, expect, test } from "bun:test";
import type { SearchItemResult } from "../store/receipts-db.ts";
import { matchCouponPurchases, parseCouponPricing } from "./s-etukortti-edut.ts";

describe("parseCouponPricing", () => {
	test("multi-word pack description with a same-unit normal price", () => {
		// Real personalised-promotions description text (sanitized product, real
		// shape): offer and "norm." price are both per-24-pack, no multiplier.
		const pricing = parseCouponPricing(
			"Hartwall Vichy 0,33L 24 pack 9,95€/pkt. (0,95/l (norm. 14,78/24-pack (sis.pantit))",
		);
		expect(pricing.offerPrice).toBe(9.95);
		expect(pricing.normalPrice).toBe(14.78);
		expect(pricing.discountPercent).toBe(33);
	});

	test("multi-pack offer compared against a per-package normal price", () => {
		// "10€/3pkt" offer vs. "norm. 4,15€/pkt" (per single package): the
		// normal price must be scaled by 3 before comparing (10 vs 12.45).
		const pricing = parseCouponPricing("10€/3pkt (6,67€-8,33€/kg, norm. 4,15€-4,63€/pkt.");
		expect(pricing.offerPrice).toBe(10);
		expect(pricing.normalPrice).toBe(4.15);
		expect(pricing.discountPercent).toBe(20);
	});

	test("description with no parseable prices returns undefined fields", () => {
		const pricing = parseCouponPricing("Osta kaksi, saat kolmannen kaupan päälle.");
		expect(pricing.offerPrice).toBeUndefined();
		expect(pricing.normalPrice).toBeUndefined();
		expect(pricing.discountPercent).toBeUndefined();
	});
});

describe("matchCouponPurchases", () => {
	function fakeItem(overrides: Partial<SearchItemResult>): SearchItemResult {
		return {
			receiptId: "1",
			store: "S-market Testilä",
			transactionStart: "2026-07-05T12:00:00+03:00",
			name: "*HARTWALL VICHY 0,33L 24-PACK",
			total: 9.95,
			quantity: null,
			unit: null,
			unitPrice: null,
			discount: null,
			notes: [],
			...overrides,
		};
	}

	test("finds a redemption via a significant title token", () => {
		const item = fakeItem({});
		const search = (query: { nameLike?: string }) =>
			query.nameLike && item.name.toUpperCase().includes(query.nameLike) ? [item] : [];

		const result = matchCouponPurchases(
			"Hartwall Vichy 24 pack 9,95€",
			"2026-07-01T00:00:00Z",
			"2026-07-31T23:59:59Z",
			search,
		);

		expect(result.likelyRedeemed).toBe(true);
		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]?.name).toBe(item.name);
	});

	test("ignores generic short/stopword tokens and reports no match when search is empty", () => {
		const calls: string[] = [];
		const search = (query: { nameLike?: string }) => {
			if (query.nameLike) calls.push(query.nameLike);
			return [];
		};

		const result = matchCouponPurchases(
			"Arkijuustoviipale 10€/3pkt",
			"2026-07-01T00:00:00Z",
			"2026-07-31T23:59:59Z",
			search,
		);

		expect(result.likelyRedeemed).toBe(false);
		expect(result.evidence).toHaveLength(0);
		// "PKT" is a generic word and should never be searched for.
		expect(calls).not.toContain("PKT");
		expect(calls).toContain("ARKIJUUSTOVIIPALE");
	});

	test("deduplicates evidence matched by multiple tokens", () => {
		const item = fakeItem({});
		const search = () => [item, item];

		const result = matchCouponPurchases(
			"Hartwall Vichy 24 pack 9,95€",
			"2026-07-01T00:00:00Z",
			"2026-07-31T23:59:59Z",
			search,
		);

		expect(result.evidence).toHaveLength(1);
	});
});
