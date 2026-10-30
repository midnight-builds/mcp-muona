import { describe, expect, test } from "bun:test";
import { APP_COOKIE_DOMAIN } from "./playwright-idp.ts";

// Forcing a login through the IdP drops only the app's cookies: losing the
// tunnistus.s-ryhma.fi ones would end the very SSO session silent logins ride.
describe("APP_COOKIE_DOMAIN", () => {
	test("matches s-etukortti.fi and its subdomains, with or without the leading dot", () => {
		for (const domain of ["s-etukortti.fi", ".s-etukortti.fi", "api.s-etukortti.fi"]) {
			expect(APP_COOKIE_DOMAIN.test(domain)).toBe(true);
		}
	});

	test("never matches the IdP or look-alike domains", () => {
		for (const domain of [
			"tunnistus.s-ryhma.fi",
			".s-ryhma.fi",
			"kirjautuminen.s-ostoslista.fi",
			"evil-s-etukortti.fi",
			"s-etukortti.fi.example.com",
		]) {
			expect(APP_COOKIE_DOMAIN.test(domain)).toBe(false);
		}
	});
});
