import { describe, expect, test } from "bun:test";
import { redactSessionTokens } from "./redact.ts";

describe("redactSessionTokens", () => {
	test("replaces a sessionToken query parameter with a redacted placeholder", () => {
		const input =
			"/redirect-to-strong-authentication?sessionToken=abc123XYZ&language=fi&redirectType=login&acr=mpki.telia.1";
		expect(redactSessionTokens(input)).toBe(
			"/redirect-to-strong-authentication?sessionToken=<redacted>&language=fi&redirectType=login&acr=mpki.telia.1",
		);
	});

	test("redacts every occurrence in a multi-link aria snapshot", () => {
		const input = [
			'- link "S-Pankki" /url: /redirect-to-strong-authentication?sessionToken=one&acr=oidc.spankki.1',
			'- link "Nordea" /url: /redirect-to-strong-authentication?sessionToken=two&acr=oidc.nordea.1',
		].join("\n");
		const result = redactSessionTokens(input);
		expect(result).not.toContain("sessionToken=one");
		expect(result).not.toContain("sessionToken=two");
		expect(result.match(/sessionToken=<redacted>/g)).toHaveLength(2);
	});

	test("leaves text without a sessionToken untouched", () => {
		const input = 'heading "Tunnistaudu pankkitunnuksillasi" [level=1]';
		expect(redactSessionTokens(input)).toBe(input);
	});
});
