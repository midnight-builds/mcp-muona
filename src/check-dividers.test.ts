import { describe, expect, test } from "bun:test";
// The check lives in scripts/, but bun test only runs tests under src/.
import { findDividers } from "../scripts/check-dividers.ts";

describe("findDividers", () => {
	test("flags titled and bare section dividers", () => {
		const text = [
			"// --- Helsinki time-of-day window ----------",
			"\t// ==========",
			"// *** Helpers ***",
			"// Section ------------------",
		].join("\n");
		expect(findDividers(text)).toEqual([1, 2, 3, 4]);
	});

	test("leaves ordinary comments and code alone", () => {
		const text = [
			"// Refresh-before-expiry, plus one retry with fresh tokens.",
			"// a -> b, then x--",
			"const dashes = '---';",
			"/* --- block comments are rare enough to leave to review --- */",
		].join("\n");
		expect(findDividers(text)).toEqual([]);
	});
});
