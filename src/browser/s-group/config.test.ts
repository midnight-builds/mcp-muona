import { describe, expect, test } from "bun:test";
import { resolveKeepaliveHours } from "./config.ts";

describe("resolveKeepaliveHours", () => {
	test("defaults to 6 when unset or empty", () => {
		expect(resolveKeepaliveHours(undefined)).toBe(6);
		expect(resolveKeepaliveHours("")).toBe(6);
	});

	test("defaults to 6 when not a number", () => {
		expect(resolveKeepaliveHours("not-a-number")).toBe(6);
	});

	test("clamps below the minimum to 1", () => {
		expect(resolveKeepaliveHours("0")).toBe(1);
		expect(resolveKeepaliveHours("-5")).toBe(1);
	});

	test("clamps above the maximum to 24", () => {
		expect(resolveKeepaliveHours("30")).toBe(24);
	});

	test("passes through an in-range value", () => {
		expect(resolveKeepaliveHours("12")).toBe(12);
	});
});
