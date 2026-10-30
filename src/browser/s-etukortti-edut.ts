// S-Etukortti "edut" (personalised offers/coupons) live entirely behind the
// edut-widget.s-cloud.fi SPA API, which requires the SPA's own bearer auth —
// it returns 401 to cookie-only requests. There is no way to read it besides
// loading the page and sniffing its own traffic, same as the CSRF page-sniff
// fallback in the S-group session module.

import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { SearchItemResult, SearchItemsQuery } from "../store/receipts-db.ts";
import { ORIGIN, sGroup } from "./s-group/index.ts";

const EDUT_ORIGIN = "https://edut-widget.s-cloud.fi";
const EDUT_LIST_PATH = "/api/personalised-promotions";
export const EDUT_PAGE = `${ORIGIN}/edut`;
const CAPTURE_TIMEOUT = 30_000;

// Deliberately lenient: `type` covers known values ("coupon", "campaign",
// "notice", "smartMarketing") but is left as a bare string so unknown future
// values don't break parsing. `discountInfo` is present on campaigns but
// usually absent on plain coupons (their pricing lives in free-text
// `description` instead — see parseCouponPricing).
export const PromotionSchema = z.object({
	type: z.string(),
	id: z.union([z.string(), z.number()]).transform((value) => String(value)),
	title: z.string(),
	description: z.string().optional(),
	validFrom: z.string().optional(),
	validTo: z.string().optional(),
	discountInfo: z
		.object({
			type: z.string(),
			originalPrice: z.object({ amount: z.number(), unit: z.string() }),
			discountedPrice: z.object({ amount: z.number(), unit: z.string() }),
		})
		.optional(),
	pobCount: z.number().optional(),
	favorite: z.boolean().optional(),
});

const PromotionsResponseSchema = z.object({
	isPersonalized: z.boolean().optional(),
	page: z.number().optional(),
	lastPage: z.number().optional(),
	data: z.array(PromotionSchema),
});

export type Promotion = z.infer<typeof PromotionSchema>;

// Captures the personalised promotions LIST response the /edut page fires
// automatically. Detail calls for a single coupon hit a different path (no
// `limit=` list parameter), so they're filtered out by requiring both the
// path prefix and that query param.
export async function fetchPromotions(): Promise<Promotion[]> {
	const body = await sGroup.capture(
		EDUT_PAGE,
		(url) => url.startsWith(`${EDUT_ORIGIN}${EDUT_LIST_PATH}`) && url.includes("limit="),
		{ timeoutMs: CAPTURE_TIMEOUT },
	);
	const parsed = PromotionsResponseSchema.parse(body);
	logger.info({ count: parsed.data.length }, "S-Etukortti promotions fetched");
	return parsed.data;
}

export interface CouponPricing {
	offerPrice?: number;
	normalPrice?: number;
	discountPercent?: number;
}

function parseFinnishNumber(raw: string): number {
	return Number(raw.replace(",", "."));
}

// First "N€" (or "N€/Mpkt") occurrence in the description is treated as the
// offer price; the optional Mpkt part records a multi-pack multiplier so it
// can be compared against a per-package normal price below.
const OFFER_PRICE_RE = /(\d+(?:,\d+)?)\s*€(?:\s*\/\s*(\d+)?\s*[a-zA-ZäöåÄÖÅ]*)?/;
// First number after "norm." — ranges ("4,15€-4,63€") are collapsed to their
// first (lower) bound, which is the best-effort choice the spec calls for.
const NORMAL_PRICE_RE = /norm\.?\s*(\d+(?:,\d+)?)/i;

// Best-effort, pure text heuristics over a coupon's free-text description —
// there is no structured pricing field on plain coupons. Returns undefined
// fields rather than guessing when a piece can't be confidently parsed.
export function parseCouponPricing(description: string): CouponPricing {
	const offerMatch = description.match(OFFER_PRICE_RE);
	const normalMatch = description.match(NORMAL_PRICE_RE);

	const offerPrice = offerMatch?.[1] ? parseFinnishNumber(offerMatch[1]) : undefined;
	const normalPrice = normalMatch?.[1] ? parseFinnishNumber(normalMatch[1]) : undefined;

	if (offerPrice === undefined || normalPrice === undefined) {
		return { offerPrice, normalPrice };
	}

	// A digit right after the offer price's "/" (e.g. "10€/3pkt") means the
	// offer covers multiple packages; the normal price is per-package, so it
	// must be scaled up before comparing totals.
	const multiplier = offerMatch?.[2] ? Number(offerMatch[2]) : 1;
	const normalTotal = normalPrice * multiplier;
	if (!(normalTotal > 0)) {
		return { offerPrice, normalPrice };
	}

	const discountPercent = Math.round((1 - offerPrice / normalTotal) * 100);
	return { offerPrice, normalPrice, discountPercent };
}

export interface CouponEvidence {
	name: string;
	total: number;
	date: string;
	store: string;
}

export interface CouponMatch {
	likelyRedeemed: boolean;
	evidence: CouponEvidence[];
}

const GENERIC_TITLE_WORDS = new Set(["PACK", "PKT", "KPL", "EURO"]);
const MIN_TOKEN_LENGTH = 4;

function tokenizeTitle(title: string): string[] {
	const tokens = title
		.toUpperCase()
		.split(/[^A-ZÅÄÖ]+/)
		.filter((token) => token.length >= MIN_TOKEN_LENGTH && !GENERIC_TITLE_WORDS.has(token));
	return Array.from(new Set(tokens));
}

// Redemption isn't reported anywhere by the API, so this infers it by
// searching the local purchase-history mirror for items whose name contains
// one of the coupon title's significant words, within the coupon's validity
// window. `search` is injected (rather than importing searchItems directly)
// so this stays unit-testable without a real SQLite database.
export function matchCouponPurchases(
	title: string,
	validFrom: string,
	validTo: string,
	search: (query: SearchItemsQuery) => SearchItemResult[],
): CouponMatch {
	const tokens = tokenizeTitle(title);
	const startDate = validFrom.slice(0, 10);
	const endDate = validTo.slice(0, 10);

	const seen = new Map<string, CouponEvidence>();
	for (const token of tokens) {
		const results = search({ nameLike: token, startDate, endDate });
		for (const item of results) {
			const key = `${item.receiptId}:${item.name}`;
			if (seen.has(key)) continue;
			seen.set(key, {
				name: item.name,
				total: item.total,
				date: item.transactionStart,
				store: item.store,
			});
		}
	}

	return { likelyRedeemed: seen.size > 0, evidence: Array.from(seen.values()) };
}
