import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";

// auth.ts reads the client credentials once at import time, so they have to be
// in the environment before the module is loaded.
process.env.OAUTH_CLIENT_ID = "test-client";
process.env.OAUTH_CLIENT_SECRET = "test-secret-0123456789";
const auth = await import("./auth.ts");

const verifier = "a-code-verifier-long-enough-for-pkce-0123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "https://claude.ai/api/mcp/auth_callback";

function newCode(): string {
	return auth.createAuthCode({
		codeChallenge: challenge,
		codeChallengeMethod: "S256",
		redirectUri,
		clientId: "test-client",
	});
}

function tamperPayload(token: string, claims: Record<string, unknown>): string {
	const [header, , signature] = token.split(".");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${header}.${payload}.${signature}`;
}

afterEach(() => {
	setSystemTime();
});

describe("client credentials", () => {
	test("accept only the configured id and secret", () => {
		expect(auth.oauthEnabled).toBe(true);
		expect(auth.validateClientCredentials("test-client", "test-secret-0123456789")).toBe(true);
		expect(auth.validateClientCredentials("test-client", "test-secret-0123456788")).toBe(false);
		expect(auth.validateClientCredentials("test-clienX", "test-secret-0123456789")).toBe(false);
		expect(auth.validateClientCredentials("test-client", "")).toBe(false);
		expect(auth.isKnownClientId("test-client")).toBe(true);
		expect(auth.isKnownClientId("other")).toBe(false);
	});
});

describe("access tokens", () => {
	test("a freshly issued access token validates, but not as a refresh token", () => {
		const { access_token, refresh_token } = auth.issueAccessToken();
		expect(auth.validateAccessToken(access_token)).toBe(true);
		expect(auth.validateRefreshToken(access_token)).toBe(false);
		expect(auth.validateRefreshToken(refresh_token)).toBe(true);
		expect(auth.validateAccessToken(refresh_token)).toBe(false);
	});

	test("a token with a rewritten payload is rejected", () => {
		const { access_token } = auth.issueAccessToken();
		const forged = tamperPayload(access_token, { exp: 9_999_999_999 });
		expect(auth.validateAccessToken(forged)).toBe(false);
	});

	test("an unsigned or malformed token is rejected", () => {
		const { access_token } = auth.issueAccessToken();
		const [header, payload] = access_token.split(".");
		expect(auth.validateAccessToken(`${header}.${payload}.`)).toBe(false);
		expect(auth.validateAccessToken(`${header}.${payload}`)).toBe(false);
		expect(auth.validateAccessToken("")).toBe(false);
		expect(auth.validateAccessToken("not-a-jwt")).toBe(false);
	});

	test("an expired access token is rejected", () => {
		const { access_token, expires_in } = auth.issueAccessToken();
		setSystemTime(new Date(Date.now() + (expires_in + 1) * 1000));
		expect(auth.validateAccessToken(access_token)).toBe(false);
	});
});

describe("authorization code exchange (PKCE)", () => {
	test("a valid code with the right verifier yields a working access token", () => {
		const tokens = auth.exchangeAuthCode({
			code: newCode(),
			codeVerifier: verifier,
			redirectUri,
			clientId: "test-client",
		});
		expect(tokens).not.toBeNull();
		expect(auth.validateAccessToken(tokens?.access_token ?? "")).toBe(true);
	});

	test("a code is single-use", () => {
		const code = newCode();
		const params = { code, codeVerifier: verifier, redirectUri, clientId: "test-client" };
		expect(auth.exchangeAuthCode(params)).not.toBeNull();
		expect(auth.exchangeAuthCode(params)).toBeNull();
	});

	test("a wrong verifier, redirect URI or client id is rejected", () => {
		expect(
			auth.exchangeAuthCode({
				code: newCode(),
				codeVerifier: `${verifier}x`,
				redirectUri,
				clientId: "test-client",
			}),
		).toBeNull();
		expect(
			auth.exchangeAuthCode({
				code: newCode(),
				codeVerifier: verifier,
				redirectUri: "https://evil.example/callback",
				clientId: "test-client",
			}),
		).toBeNull();
		expect(
			auth.exchangeAuthCode({
				code: newCode(),
				codeVerifier: verifier,
				redirectUri,
				clientId: "other",
			}),
		).toBeNull();
	});

	test("an expired code is rejected", () => {
		const code = newCode();
		setSystemTime(new Date(Date.now() + 61_000));
		expect(
			auth.exchangeAuthCode({ code, codeVerifier: verifier, redirectUri, clientId: "test-client" }),
		).toBeNull();
	});

	test("only the S256 challenge method is accepted", () => {
		expect(() =>
			auth.createAuthCode({
				codeChallenge: verifier,
				codeChallengeMethod: "plain",
				redirectUri,
				clientId: "test-client",
			}),
		).toThrow();
	});
});
