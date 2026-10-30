import { describe, expect, test } from "bun:test";
import { parseReceiptText } from "./receipt-text.ts";

// Synthetic receipt modeled on the real S-market POS printout layout
// (starred item lines, weighed items, TASAERÄ multi-buy groups, campaign discounts).
const SAMPLE = `
   TESTIOSUUSKAUPPA 0000000-0
     S-MARKET TESTILÄ 010-0000000

K001   M000001/0001    1.1.2026   12:00

ASIAKASOMISTAJAN edut on huomioitu.
------------------------------------------
*KASVISSEKOITUS PAKASTE               3,77 *
*KANAN KOIPIREISI MARINOI             3,66 *
  1,126 KG          3,25 €/KG
*TASAERÄ 2 KPL / 3,00 €               3,00 *
  *MEETVURSTI                       *
    2 KPL       1,99 €/KPL    3,98
  KAMPANJA                   -0,98
*KEVYTMAITOJUOMA LAKTON               1,39 *
*BANAANI                              1,56 *
  0,784 KG          1,99 €/KG
------------------------------------------
YHTEENSÄ                            13,38

BONUSTA KERRYTTÄVÄT OSTOT    13,38
     Jäsennumero ****  **0000

KORTTITAPAHTUMA
Debit/Veloitus                13,38 EUR

ALV         VEROTON     VERO   VEROLLINEN
6  13,50%     11,79     1,59        13,38
YHTEENSÄ      11,79     1,59        13,38
`;

describe("parseReceiptText", () => {
	const parsed = parseReceiptText(SAMPLE);

	test("finds all item lines", () => {
		expect(parsed.items.map((i) => i.name)).toEqual([
			"KASVISSEKOITUS PAKASTE",
			"KANAN KOIPIREISI MARINOI",
			"TASAERÄ 2 KPL / 3,00 €",
			"KEVYTMAITOJUOMA LAKTON",
			"BANAANI",
		]);
	});

	test("parses item totals as numbers", () => {
		expect(parsed.items.map((i) => i.total)).toEqual([3.77, 3.66, 3.0, 1.39, 1.56]);
	});

	test("attaches weight and unit price to weighed items", () => {
		const chicken = parsed.items[1];
		expect(chicken?.quantity).toBe(1.126);
		expect(chicken?.unit).toBe("KG");
		expect(chicken?.unitPrice).toBe(3.25);

		const banana = parsed.items[4];
		expect(banana?.quantity).toBe(0.784);
		expect(banana?.unitPrice).toBe(1.99);
	});

	test("attaches group quantity, discount and sub-item note to TASAERÄ blocks", () => {
		const group = parsed.items[2];
		expect(group?.quantity).toBe(2);
		expect(group?.unit).toBe("KPL");
		expect(group?.unitPrice).toBe(1.99);
		expect(group?.discount).toBe(-0.98);
		expect(group?.notes).toContain("MEETVURSTI");
		expect(group?.notes).toContain("KAMPANJA");
	});

	test("reads the receipt total and stops at YHTEENSÄ", () => {
		expect(parsed.total).toBe(13.38);
		// VAT table and card payment lines must not leak into items
		expect(parsed.items).toHaveLength(5);
	});

	test("captures the store header", () => {
		expect(parsed.storeHeader).toBe("TESTIOSUUSKAUPPA 0000000-0");
	});
});

describe("parseReceiptText edge cases", () => {
	test("empty input", () => {
		const parsed = parseReceiptText("");
		expect(parsed.items).toEqual([]);
		expect(parsed.total).toBeNull();
	});

	test("unstarred item lines (other chains)", () => {
		const parsed = parseReceiptText(
			["HEADER", "----------", "KAHVIPAKETTI            4,99", "YHTEENSÄ     4,99"].join("\n"),
		);
		expect(parsed.items).toEqual([{ name: "KAHVIPAKETTI", total: 4.99, notes: [] }]);
		expect(parsed.total).toBe(4.99);
	});

	test("negative item lines (pantti return)", () => {
		const parsed = parseReceiptText(
			["HEADER", "----------", "PULLOPALAUTUS          -1,20", "YHTEENSÄ     0,00"].join("\n"),
		);
		expect(parsed.items[0]?.total).toBe(-1.2);
	});

	test("fuel-pump receipt: mixed-case Yhteensä with EUR suffix, VAT row excluded", () => {
		const parsed = parseReceiptText(
			[
				"ABC TESTI",
				"KORTTIAUTOMAATTI",
				"REF.  111111E  01.01.26 12:00:00  AUT: 00",
				"1 BE 95 E10  30,00  2,000      60,00 EUR",
				"ALV  %   Veroton     Vero Verollinen",
				"25,50      47,81    12,19      60,00 EUR",
				"Yhteensä                       60,00 EUR",
				"Debit/Veloitus                 60,00 EUR",
			].join("\n"),
		);
		expect(parsed.total).toBe(60);
		expect(parsed.items).toHaveLength(1);
		expect(parsed.items[0]?.total).toBe(60);
	});

	test("EV-charging receipt: VÄLISUMMA not doubled, KWH quantity attached", () => {
		const parsed = parseReceiptText(
			[
				"ABC",
				"----------------------------------------",
				"SUURTEHOLATAUS KWH                  3,50",
				"  10,000 KWH 0,35 €/KWH",
				"----------------------------------------",
				"VÄLISUMMA                           3,50",
				"YHTEENSÄ                            3,50",
				"MAKSUTAPA                    Korttimaksu",
			].join("\n"),
		);
		expect(parsed.total).toBe(3.5);
		expect(parsed.items).toHaveLength(1);
		expect(parsed.items[0]?.quantity).toBe(10);
		expect(parsed.items[0]?.unit).toBe("KWH");
	});

	test("indented PANTTI lines inside TASAERÄ blocks are real charges", () => {
		const parsed = parseReceiptText(
			[
				"KAUPPA",
				"------------------------------------------",
				"*TASAERÄ 2 KPL / 4,60 €               4,60 *",
				"  *VADELMA-MELONI 0,5L         2,79 *",
				"  *MULTI B+C 0,5L              2,79 *",
				"  KAMPANJA                   -0,98",
				"  *PANTTI KMP 0,351-0,99L, V          0,20 *",
				"*ANANAS SOKERITON 0,5L                1,43 *",
				"*PANTTI KMP0,351-0,999L, K            0,20 *",
				"------------------------------------------",
				"YHTEENSÄ                             6,43",
			].join("\n"),
		);
		const sum = parsed.items.reduce((a, i) => a + i.total, 0);
		expect(sum).toBeCloseTo(6.43, 2);
		expect(parsed.items.map((i) => i.name)).toContain("PANTTI KMP 0,351-0,99L, V");
		// component unit prices stay as notes, not items
		expect(parsed.items.map((i) => i.name)).not.toContain("VADELMA-MELONI 0,5L");
	});

	test("old format (pre-2023): dot decimals, EUR/KG unit prices, integer KPL groups", () => {
		const parsed = parseReceiptText(
			[
				"   ETELÄ-KARJALAN OSUUSKAUPPA 0162170-6",
				"    S-MARKET TESTILÄ 010 00 00000",
				"1  K1  M000001/0002   12:00   01-01-2019",
				"MUOVIKASSI 40L VALKOINEN           0.20 ",
				"LIBERO UP&GO 6 MEGA               15.39 ",
				"RASVATON MAITO                     4.50 ",
				"     6 KPL       0.75 EUR/KPL",
				"PAPRIKA PUNAINEN IRTO              1.69 ",
				"  0.490 KG       3.45 EUR/KG",
				"                              ----------",
				"YHTEENSÄ                          21.78 ",
				"KORTTITAPAHTUMA",
			].join("\n"),
		);
		expect(parsed.total).toBe(21.78);
		const sum = parsed.items.reduce((a, i) => a + i.total, 0);
		expect(sum).toBeCloseTo(21.78, 2);
		const milk = parsed.items.find((i) => i.name === "RASVATON MAITO");
		expect(milk?.quantity).toBe(6);
		expect(milk?.unit).toBe("KPL");
		expect(milk?.unitPrice).toBe(0.75);
		const paprika = parsed.items.find((i) => i.name === "PAPRIKA PUNAINEN IRTO");
		expect(paprika?.quantity).toBe(0.49);
		expect(paprika?.unit).toBe("KG");
	});

	test("old format trailing-minus discounts reduce the item sum", () => {
		const parsed = parseReceiptText(
			[
				"   OSUUSKAUPPA",
				"    S-MARKET TESTILÄ",
				"JÄÄSALAATTI PAK.                   2.30 ",
				"% ALENNUS   30%                    0.42-",
				"YHTEENSÄ                           1.88 ",
			].join("\n"),
		);
		expect(parsed.total).toBe(1.88);
		const sum = parsed.items.reduce((a, i) => a + i.total, 0);
		expect(sum).toBeCloseTo(1.88, 2);
		const discount = parsed.items.find((i) => i.name.includes("ALENNUS"));
		expect(discount?.total).toBeCloseTo(-0.42, 2);
	});

	test("VAT table rows are not counted as items (no letters before the price)", () => {
		const parsed = parseReceiptText(
			[
				"   OSUUSKAUPPA",
				"    S-MARKET TESTILÄ",
				"KAHVI                              4.99 ",
				"YHTEENSÄ                           4.99 ",
				"ALV         VEROTON     VERO   VEROLLINEN",
				"6  13,50%      4,39     0,60         4,99",
			].join("\n"),
		);
		expect(parsed.items).toHaveLength(1);
		expect(parsed.items[0]?.name).toBe("KAHVI");
	});

	test("unrecognized top-level lines are preserved", () => {
		const parsed = parseReceiptText(
			["HEADER", "JOTAIN OUTOA ILMAN HINTAA", "YHTEENSÄ     1,00"].join("\n"),
		);
		expect(parsed.unparsedLines).toContain("JOTAIN OUTOA ILMAN HINTAA");
	});
});
