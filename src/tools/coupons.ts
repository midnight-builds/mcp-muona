import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	fetchPromotions,
	matchCouponPurchases,
	parseCouponPricing,
} from "../browser/s-etukortti-edut.ts";
import { searchItems } from "../store/receipts-db.ts";
import { ok, run } from "./tool-result.ts";

export function registerCouponsTools(server: McpServer): void {
	server.registerTool(
		"get_coupons",
		{
			description:
				"List personalised S-Etukortti coupons/offers (edut) from s-etukortti.fi/edut, with " +
				"best-effort pricing and redemption info attached. `pricing` is parsed heuristically " +
				"from each coupon's free-text description (offer/normal price, discount %) — treat it " +
				"as approximate. `likelyRedeemed`/`evidence` are INFERRED by matching the coupon title's " +
				"significant words against the LOCAL synced purchase history within the coupon's " +
				"validity window: run sync_receipts first for reliable results, and note that a missing " +
				"match can mean either the coupon wasn't used, or its receipt just hasn't been synced yet.",
			inputSchema: z.object({
				onlyCoupons: z
					.boolean()
					.default(true)
					.describe(
						"Only include entries with type === 'coupon' (excludes campaigns/notices/smartMarketing)",
					),
			}),
		},
		async ({ onlyCoupons }) =>
			run("Error fetching coupons", async () => {
				const promotions = await fetchPromotions();
				const filtered = onlyCoupons ? promotions.filter((p) => p.type === "coupon") : promotions;

				const coupons = filtered.map((promo) => {
					const { likelyRedeemed, evidence } = matchCouponPurchases(
						promo.title,
						promo.validFrom ?? "",
						promo.validTo ?? "",
						searchItems,
					);
					return {
						title: promo.title,
						description: promo.description,
						validFrom: promo.validFrom,
						validTo: promo.validTo,
						pricing: parseCouponPricing(promo.description ?? ""),
						likelyRedeemed,
						evidence,
					};
				});

				return ok({ count: coupons.length, coupons });
			}),
	);
}
