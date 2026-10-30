// Parses the plain-text receiptData returned by the S-Etukortti receipts API
// into structured line items. The text is a fixed-width POS printout; the exact
// layout varies per chain, so parsing is tolerant: anything that doesn't match
// a known line shape is preserved in `unparsedLines` instead of being dropped.

export interface ReceiptItem {
	name: string;
	total: number;
	quantity?: number;
	unit?: string;
	unitPrice?: number;
	discount?: number;
	notes: string[];
}

export interface ParsedReceipt {
	items: ReceiptItem[];
	total: number | null;
	storeHeader: string | null;
	unparsedLines: string[];
}

function parseAmount(text: string): number {
	return Number.parseFloat(text.replace(",", "."));
}

// Amounts use a comma decimal on newer receipts ("1,56") and a dot on older
// ones (pre-2023, "15.39"); unit prices are marked "€/KG" or the older "EUR/KG".
const AMT = "\\d+[.,]\\d{2}";
const UNIT = "KG|L|KPL|KWH";
const PER = "(?:€|EUR)";
// e.g. "*BANAANI CHIQUITA    1,56 *", "LIBERO UP&GO 6 MEGA   15.39" or
// fuel-pump "1 BE 95 E10  30,00  2,000      60,00 EUR"
const ITEM_LINE = new RegExp(`^\\*?(\\S.*?)\\s{2,}(-?${AMT})(?:\\s*EUR)?\\s*\\*?\\s*$`);
// e.g. "  0,784 KG   1,99 €/KG", "  10,000 KWH 0,35 €/KWH" or old
// "     2 KPL       1.15 EUR/KPL" (integer quantity, dot decimals, EUR/)
const QUANTITY_LINE = new RegExp(
	`^\\s+(\\d+(?:[.,]\\d+)?)\\s*(${UNIT})\\s+(${AMT})\\s*${PER}\\/(${UNIT})\\s*$`,
	"i",
);
// e.g. "  KAMPANJA                   -0,98" — a discount applied to the item above
const DISCOUNT_LINE = /^\s+(\S.*?)\s{2,}(-\d+[.,]\d{2})\s*$/;
// Older receipts write discounts with the minus after the amount, at column 0:
// "% ALENNUS   30%                    0.42-"
const TRAILING_MINUS_LINE = new RegExp(`^(\\S.*?)\\s{2,}(${AMT})-\\s*$`);
// e.g. "    2 KPL       1,99 €/KPL    3,98" — group line inside TASAERÄ blocks
const GROUP_QUANTITY_LINE = new RegExp(
	`^\\s+(\\d+(?:[.,]\\d+)?)\\s*(KPL|KG|L)\\s+(${AMT})\\s*${PER}\\/(KPL|KG|L)\\s+(${AMT})\\s*$`,
	"i",
);
// Fuel-pump receipts print "Yhteensä    60,00 EUR" in mixed case
const TOTAL_LINE = new RegExp(`^YHTEENSÄ\\s+(${AMT})(?:\\s*EUR)?\\s*$`, "i");
const SEPARATOR_LINE = /^-{10,}\s*$/;
// Subtotal/summary rows that would otherwise look like priced item lines
// (VÄLISUMMA on EV-charging receipts would double the item sum)
const SUMMARY_KEYWORD_LINE = /^(VÄLISUMMA|YHT\.|ALV\b|BONUSTA|KORTTITAPAHTUMA|Debit|Veloitus)/i;
// VAT table rows ("25,50  47,81  12,19  60,00 EUR", "6  13,50%  13,70  1,86")
// carry several amounts and, unlike a real product line, no letters in the part
// before the price. Requiring a letter keeps PANTTI/fuel lines (whose names
// contain digits like "PANTTI KMP0,351-0,999L") while dropping the VAT table.
const AMT_GLOBAL = new RegExp(`${AMT}`, "g");
const HAS_LETTER = /[A-Za-zÅÄÖåäö]/;
function looksLikeVatRow(body: string): boolean {
	return !HAS_LETTER.test(body) && (body.match(AMT_GLOBAL) ?? []).length >= 1;
}

export function parseReceiptText(receiptData: string): ParsedReceipt {
	const lines = receiptData.split("\n");
	const items: ReceiptItem[] = [];
	const unparsedLines: string[] = [];
	let total: number | null = null;
	let storeHeader: string | null = null;
	let currentItem: ReceiptItem | null = null;
	// Everything after YHTEENSÄ is payment/VAT/footer noise — stop item parsing there.
	let afterTotal = false;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (line.trim() === "") continue;

		if (storeHeader === null) {
			storeHeader = line.trim();
			continue;
		}

		const totalMatch = line.match(TOTAL_LINE);
		if (totalMatch?.[1] && !afterTotal) {
			total = parseAmount(totalMatch[1]);
			afterTotal = true;
			currentItem = null;
			continue;
		}
		if (afterTotal) continue;

		if (SEPARATOR_LINE.test(line)) continue;

		// Older receipts print discounts at column 0 with a trailing minus
		// ("% ALENNUS   30%    0.42-") and gross item prices above them, so the
		// discount is a real reduction — record it as its own negative line to
		// keep the item sum equal to the receipt total.
		const trailingDiscount = line.match(TRAILING_MINUS_LINE);
		if (trailingDiscount?.[1] && trailingDiscount[2]) {
			const entry: ReceiptItem = {
				name: trailingDiscount[1].trim(),
				total: -parseAmount(trailingDiscount[2]),
				notes: [],
			};
			items.push(entry);
			if (currentItem)
				currentItem.discount = (currentItem.discount ?? 0) - parseAmount(trailingDiscount[2]);
			continue;
		}

		const groupQty = line.match(GROUP_QUANTITY_LINE);
		if (groupQty?.[1] && groupQty[2] && groupQty[3] && currentItem) {
			currentItem.quantity = parseAmount(groupQty[1]);
			currentItem.unit = groupQty[2].toUpperCase();
			currentItem.unitPrice = parseAmount(groupQty[3]);
			continue;
		}

		const qty = line.match(QUANTITY_LINE);
		if (qty?.[1] && qty[2] && qty[3] && currentItem) {
			currentItem.quantity = parseAmount(qty[1]);
			currentItem.unit = qty[2].toUpperCase();
			currentItem.unitPrice = parseAmount(qty[3]);
			continue;
		}

		// Item lines start at column 0; indented lines belong to the item above.
		const indented = /^\s/.test(rawLine);

		if (!indented) {
			const item = line.match(ITEM_LINE);
			if (item?.[1] && item[2] && !SUMMARY_KEYWORD_LINE.test(line) && !looksLikeVatRow(item[1])) {
				currentItem = { name: item[1].trim(), total: parseAmount(item[2]), notes: [] };
				items.push(currentItem);
				continue;
			}
		} else if (currentItem) {
			const discount = line.match(DISCOUNT_LINE);
			if (discount?.[1] && discount[2]) {
				currentItem.discount = (currentItem.discount ?? 0) + parseAmount(discount[2]);
				currentItem.notes.push(discount[1].trim());
				continue;
			}
			// Inside a TASAERÄ block, indented PANTTI lines are real charges on
			// top of the group price; other indented priced lines are the group's
			// component unit prices, already covered by the group total.
			const subItem = line.trim().match(ITEM_LINE);
			if (subItem?.[1] && subItem[2] && /^\*?\s*PANTTI/i.test(subItem[1].trim())) {
				items.push({
					name: subItem[1].trim().replace(/^\*\s*/, ""),
					total: parseAmount(subItem[2]),
					notes: [],
				});
				continue;
			}
			const note = line
				.trim()
				.replace(/^\*|\*$/g, "")
				.trim();
			if (note) currentItem.notes.push(note);
			continue;
		}

		unparsedLines.push(line);
	}

	return { items, total, storeHeader, unparsedLines };
}
