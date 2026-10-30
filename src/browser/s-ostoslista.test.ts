import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger.ts";
import {
	buildAuthorization,
	decodeJwtExpiry,
	extractGraphqlData,
	getStatus,
	gql,
	LOGIN_HINT,
	loginWith,
	NotLoggedInError,
	needsRefresh,
	PastProductsDataSchema,
	parseCallbackUrl,
	type RunLoginFlow,
	resetTokenCache,
	ShoppingListsDataSchema,
	setAutoLogin,
	TokenResponseSchema,
} from "./s-ostoslista.ts";

// Shapes follow the GraphQL schema shipped inside the S-ostoslista APK
// (data-capture/s-ostoslista/schema.graphql); values are synthetic.

function fakeJwt(payload: Record<string, unknown>): string {
	const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
	return `${b64({ alg: "RS256" })}.${b64(payload)}.signature`;
}

describe("parseCallbackUrl", () => {
	test("returns the nonce from a successful callback", () => {
		expect(
			parseCallbackUrl("https://kirjautuminen.s-ostoslista.fi/callback?response=ok&nonce=abc123"),
		).toEqual({ kind: "nonce", nonce: "abc123" });
	});

	test("maps expired/error/cancelled responses to failures", () => {
		for (const reason of ["expired", "error", "cancelled"] as const) {
			expect(
				parseCallbackUrl(`https://kirjautuminen.s-ostoslista.fi/callback?response=${reason}`),
			).toEqual({ kind: "failed", reason });
		}
	});

	test("ignores the intermediate OIDC code callback without a nonce", () => {
		expect(
			parseCallbackUrl("https://kirjautuminen.s-ostoslista.fi/callback?code=xyz&state=s"),
		).toBeNull();
	});

	test("ignores other origins and paths", () => {
		expect(parseCallbackUrl("https://evil.example/callback?nonce=abc")).toBeNull();
		expect(parseCallbackUrl("https://kirjautuminen.s-ostoslista.fi/login?nonce=abc")).toBeNull();
		expect(parseCallbackUrl("not a url")).toBeNull();
	});
});

describe("decodeJwtExpiry", () => {
	test("reads exp seconds from the payload", () => {
		expect(decodeJwtExpiry(fakeJwt({ exp: 1_800_000_000, sub: "x" }))).toBe(1_800_000_000);
	});

	test("returns null for malformed tokens or missing exp", () => {
		expect(decodeJwtExpiry("nope")).toBeNull();
		expect(decodeJwtExpiry(fakeJwt({ sub: "x" }))).toBeNull();
	});
});

describe("needsRefresh", () => {
	test("refreshes within the skew window before expiry", () => {
		expect(needsRefresh(1_000, 1_000 * 1000 - 30_000)).toBe(true);
		expect(needsRefresh(1_000, 1_000 * 1000 - 300_000)).toBe(false);
	});

	test("refreshes when expiry is unknown", () => {
		expect(needsRefresh(null, 0)).toBe(true);
	});
});

describe("buildAuthorization", () => {
	test("joins anonymous and registered tokens with a comma like the app", () => {
		expect(buildAuthorization("anon", "access")).toBe("anon,access");
	});

	test("uses the anonymous token alone when not logged in", () => {
		expect(buildAuthorization("anon", null)).toBe("anon");
	});
});

describe("TokenResponseSchema", () => {
	test("parses /verify and /refresh responses", () => {
		const parsed = TokenResponseSchema.parse({
			accessToken: "a",
			idToken: "i",
			refreshToken: "r",
		});
		expect(parsed.refreshToken).toBe("r");
	});

	test("rejects partial token sets", () => {
		expect(() => TokenResponseSchema.parse({ accessToken: "a" })).toThrow();
	});
});

describe("extractGraphqlData", () => {
	test("returns data parsed by the given schema", () => {
		const data = extractGraphqlData(
			{
				data: {
					shoppingLists: [
						{
							id: "l1",
							name: "Viikko",
							mode: "PLAN",
							storeId: "513971200",
							shared: true,
							permissions: ["READ", "WRITE", "SHARE"],
							modifiedAt: "2026-10-17T10:00:00.000Z",
							store: { id: "513971200", name: "Prisma Testi" },
							items: [
								{
									__typename: "ShoppingListItem",
									id: "i1",
									name: "maito",
									collected: false,
									products: [{ ean: "6408430000000", quantity: 2 }],
								},
								{
									__typename: "ProductResolvedShoppingListItem",
									id: "i2",
									name: "Valio rasvaton maito 1l",
									collected: true,
									ean: "6408430000017",
									quantity: 1,
									quantityUnit: "KPL",
									sokId: "123",
									product: {
										name: "Valio rasvaton maito 1l",
										ean: "6408430000017",
										pricing: { currentPrice: 1.19, regularPrice: 1.29 },
										location: { aisle: "12", label: "Maito" },
									},
								},
							],
						},
					],
				},
			},
			ShoppingListsDataSchema,
		);
		expect(data.shoppingLists[0]?.items).toHaveLength(2);
		expect(data.shoppingLists[0]?.shared).toBe(true);
	});

	test("throws with the GraphQL error messages", () => {
		expect(() =>
			extractGraphqlData(
				{ data: null, errors: [{ message: "Unauthorized", errorType: "UnauthorizedException" }] },
				ShoppingListsDataSchema,
			),
		).toThrow(/Unauthorized/);
	});

	test("parses pastProducts with nullable list", () => {
		const data = extractGraphqlData(
			{
				data: {
					pastProducts: [
						{
							isWeeklyProduct: true,
							latestQuantity: 2,
							totalCount: 14,
							product: { name: "Banaani", ean: "2000000000000", pricing: { currentPrice: 1.99 } },
						},
					],
				},
			},
			PastProductsDataSchema,
		);
		expect(data.pastProducts?.[0]?.totalCount).toBe(14);
		expect(extractGraphqlData({ data: { pastProducts: null } }, PastProductsDataSchema)).toEqual({
			pastProducts: null,
		});
	});
});

describe("gql token handling", () => {
	const dir = mkdtempSync(join(tmpdir(), "s-ostoslista-"));
	const path = join(dir, "tokens.json");
	const realFetch = globalThis.fetch;
	type Call = { url: string; headers: Record<string, string>; body: string };
	let calls: Call[] = [];
	let flowCalls = 0;
	let nowMs = 0;

	function writeTokens(accessExp: number) {
		writeFileSync(
			path,
			JSON.stringify({
				anonymousToken: "anon",
				registered: {
					accessToken: fakeJwt({ exp: accessExp }),
					idToken: "id",
					refreshToken: "refresh-1",
					accessTokenExpiresAt: accessExp,
					loggedInAt: "2026-10-17T00:00:00.000Z",
					refreshedAt: null,
				},
			}),
		);
	}

	function mockFetch(responder: (call: Call) => Response) {
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const call: Call = {
					url: String(input),
					headers: Object.fromEntries(new Headers(init?.headers).entries()),
					body: String(init?.body ?? ""),
				};
				calls.push(call);
				return responder(call);
			},
			{ preconnect: realFetch.preconnect },
		);
	}

	const listsBody = JSON.stringify({ data: { shoppingLists: [] } });
	const future = () => Math.floor(Date.now() / 1000) + 3600;

	beforeEach(() => {
		process.env.S_OSTOSLISTA_TOKEN_PATH = path;
		process.env.S_OSTOSLISTA_API_KEY = "test-key";
		resetTokenCache();
		calls = [];
		// Default: the S-group session says a human is needed, so no test can
		// reach the real browser by accident.
		flowCalls = 0;
		nowMs = Date.parse("2026-10-29T10:00:00Z");
		setAutoLogin({
			runFlow: async () => {
				flowCalls++;
				return { kind: "declined", reason: "blocked", detail: "x" };
			},
			now: () => nowMs,
		});
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		rmSync(path, { force: true });
	});

	test("uses a valid access token directly", async () => {
		writeTokens(future());
		mockFetch(() => new Response(listsBody));
		await gql("query GetShoppingLists { shoppingLists { id } }", {}, ShoppingListsDataSchema);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.authorization).toStartWith("anon,");
	});

	test("refreshes an expiring access token first and persists it as 0600", async () => {
		writeTokens(Math.floor(Date.now() / 1000) + 10);
		const newAccess = fakeJwt({ exp: future() });
		mockFetch((call) =>
			call.url.endsWith("/refresh")
				? new Response(
						JSON.stringify({ accessToken: newAccess, idToken: "id2", refreshToken: "refresh-2" }),
					)
				: new Response(listsBody),
		);
		await gql("query GetShoppingLists { shoppingLists { id } }", {}, ShoppingListsDataSchema);
		expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/refresh", "/graphql"]);
		expect(calls[0]?.body).toBe("refresh-1");
		expect(calls[1]?.headers.authorization).toBe(`anon,${newAccess}`);
		const stored = JSON.parse(readFileSync(path, "utf8"));
		expect(stored.registered.refreshToken).toBe("refresh-2");
		expect(stored.registered.refreshedAt).not.toBeNull();
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("rejected refresh drops the stored login and reports not logged in", async () => {
		writeTokens(Math.floor(Date.now() / 1000) - 10);
		mockFetch(() => new Response("", { status: 400 }));
		await expect(
			gql("query GetShoppingLists { shoppingLists { id } }", {}, ShoppingListsDataSchema),
		).rejects.toBeInstanceOf(NotLoggedInError);
		expect(JSON.parse(readFileSync(path, "utf8")).registered).toBeNull();
	});

	test("retries once with renewed tokens after an unauthorized response", async () => {
		writeTokens(future());
		const newAccess = fakeJwt({ exp: future() });
		let graphqlCalls = 0;
		mockFetch((call) => {
			const pathname = new URL(call.url).pathname;
			if (pathname === "/refresh") {
				return new Response(
					JSON.stringify({ accessToken: newAccess, idToken: "id2", refreshToken: "refresh-2" }),
				);
			}
			if (call.body.includes("anonymousUserToken")) {
				expect(call.headers["x-api-key"]).toBe("test-key");
				return new Response(JSON.stringify({ data: { anonymousUserToken: "anon-2" } }));
			}
			graphqlCalls++;
			return graphqlCalls === 1
				? new Response(
						JSON.stringify({ errors: [{ message: "nope", errorType: "UnauthorizedException" }] }),
						{ status: 401 },
					)
				: new Response(listsBody);
		});
		await gql("query GetShoppingLists { shoppingLists { id } }", {}, ShoppingListsDataSchema);
		expect(graphqlCalls).toBe(2);
		expect(calls.at(-1)?.headers.authorization).toBe(`anon-2,${newAccess}`);
	});

	test("transient refresh failure keeps the stored refresh token", async () => {
		writeTokens(Math.floor(Date.now() / 1000) - 10);
		mockFetch(() => new Response("Bad Gateway", { status: 502 }));
		await expect(
			gql("query GetShoppingLists { shoppingLists { id } }", {}, ShoppingListsDataSchema),
		).rejects.toThrow(/502/);
		expect(JSON.parse(readFileSync(path, "utf8")).registered.refreshToken).toBe("refresh-1");
	});

	test("a corrupt token file reads as logged out instead of throwing", async () => {
		writeFileSync(path, '{"anonymousToken": "an');
		mockFetch(() => new Response(JSON.stringify({ data: { anonymousUserToken: "anon" } })));
		await expect(
			gql("query GetShoppingLists { shoppingLists { id } }", {}, ShoppingListsDataSchema),
		).rejects.toBeInstanceOf(NotLoggedInError);
	});

	test("still unauthorized after renewal reports not logged in", async () => {
		writeTokens(future());
		const newAccess = fakeJwt({ exp: future() });
		mockFetch((call) => {
			if (call.url.endsWith("/refresh")) {
				return new Response(
					JSON.stringify({ accessToken: newAccess, idToken: "id2", refreshToken: "refresh-2" }),
				);
			}
			if (call.body.includes("anonymousUserToken")) {
				return new Response(JSON.stringify({ data: { anonymousUserToken: "anon-2" } }));
			}
			return new Response(
				JSON.stringify({ errors: [{ message: "nope", errorType: "UnauthorizedException" }] }),
				{ status: 401 },
			);
		});
		await expect(
			gql("query GetShoppingLists { shoppingLists { id } }", {}, ShoppingListsDataSchema),
		).rejects.toBeInstanceOf(NotLoggedInError);
	});

	test("refuses data calls when never logged in", async () => {
		mockFetch(() => new Response(JSON.stringify({ data: { anonymousUserToken: "anon" } })));
		await expect(
			gql("query GetShoppingLists { shoppingLists { id } }", {}, ShoppingListsDataSchema),
		).rejects.toBeInstanceOf(NotLoggedInError);
	});
	describe("automatic login on NotLoggedInError", () => {
		const callback = "https://kirjautuminen.s-ostoslista.fi/callback?response=ok&nonce=n1";
		const query = "query GetShoppingLists { shoppingLists { id } }";
		const freshAccess = () => fakeJwt({ exp: future() });
		let graphqlPosts = 0;
		let loggedIn = false;

		function useFlow(outcome: Awaited<ReturnType<RunLoginFlow>>, gate?: Promise<void>) {
			setAutoLogin({
				runFlow: async () => {
					flowCalls++;
					await gate;
					return outcome;
				},
				now: () => nowMs,
			});
		}

		// The graphql endpoint accepts only the token minted by /verify, so a
		// call succeeds exactly when the silent login really stored new tokens.
		function mockBackend(opts?: { alwaysUnauthorized?: boolean; refreshStatus?: number }) {
			graphqlPosts = 0;
			loggedIn = false;
			const verified = freshAccess();
			mockFetch((call) => {
				const pathname = new URL(call.url).pathname;
				if (pathname === "/verify") {
					loggedIn = true;
					return new Response(
						JSON.stringify({ accessToken: verified, idToken: "id", refreshToken: "r-new" }),
					);
				}
				if (pathname === "/refresh") {
					if (opts?.refreshStatus) return new Response("", { status: opts.refreshStatus });
					return new Response(
						JSON.stringify({ accessToken: freshAccess(), idToken: "i", refreshToken: "r-2" }),
					);
				}
				if (call.body.includes("anonymousUserToken")) {
					return new Response(JSON.stringify({ data: { anonymousUserToken: "anon" } }));
				}
				graphqlPosts++;
				const authorised =
					!opts?.alwaysUnauthorized && call.headers.authorization?.includes(verified);
				return authorised
					? new Response(listsBody)
					: new Response(
							JSON.stringify({ errors: [{ message: "x", errorType: "UnauthorizedException" }] }),
							{ status: 401 },
						);
			});
		}

		test("a rejected refresh runs one silent flow and the call is retried", async () => {
			writeTokens(Math.floor(Date.now() / 1000) - 10);
			mockBackend({ refreshStatus: 400 });
			useFlow({ kind: "callback", url: callback });
			const data = await gql(query, {}, ShoppingListsDataSchema);
			expect(data.shoppingLists).toEqual([]);
			expect(flowCalls).toBe(1);
			expect(loggedIn).toBe(true);
		});

		test("never logged in also logs in by itself", async () => {
			mockBackend();
			useFlow({ kind: "callback", url: callback });
			await gql(query, {}, ShoppingListsDataSchema);
			expect(flowCalls).toBe(1);
		});

		test("parallel calls share one flow", async () => {
			mockBackend();
			let release: () => void = () => {};
			useFlow(
				{ kind: "callback", url: callback },
				new Promise<void>((r) => {
					release = r;
				}),
			);
			const both = Promise.all([
				gql(query, {}, ShoppingListsDataSchema),
				gql(query, {}, ShoppingListsDataSchema),
			]);
			await new Promise((r) => setTimeout(r, 20));
			release();
			await both;
			expect(flowCalls).toBe(1);
		});

		test("needs_human throws a hint to finish the S-Etukortti login and never loops", async () => {
			mockBackend();
			useFlow({ kind: "needs_human", detail: "otp" });
			const err = await gql(query, {}, ShoppingListsDataSchema).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(NotLoggedInError);
			if (!(err instanceof Error)) return;
			expect(err.message).toContain("s_etukortti_login_*");
			expect(err.message).toContain("log in by themselves");
			// Said once: the hint used to come twice in near-identical wording.
			expect(err.message.split("revives the S-tunnus SSO session")).toHaveLength(2);
			expect(err.message).not.toContain("s_ostoslista_login");
			expect(flowCalls).toBe(1);
			expect(graphqlPosts).toBe(0);
		});

		test("blocked, busy and no_saved_email end in NotLoggedInError without a cooldown", async () => {
			mockBackend();
			for (const reason of ["blocked", "login_in_progress", "no_saved_email"] as const) {
				useFlow({ kind: "declined", reason, detail: "d" });
				await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toBeInstanceOf(
					NotLoggedInError,
				);
			}
			expect(flowCalls).toBe(3);
		});

		test("a failed flow starts a 20 min cooldown, after which a flow is tried again", async () => {
			mockBackend();
			useFlow({ kind: "failed", reason: "timeout", detail: "no callback" });
			await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toBeInstanceOf(
				NotLoggedInError,
			);
			expect(flowCalls).toBe(1);

			nowMs += 5 * 60_000;
			const info = spyOn(logger, "info");
			const err = await gql(query, {}, ShoppingListsDataSchema).catch((e: unknown) => e);
			const skips = info.mock.calls
				.filter((call) => call.includes("S-ostoslista automatic login skipped: cooling down"))
				.map((call) => call[0]);
			info.mockRestore();
			expect(err).toBeInstanceOf(NotLoggedInError);
			if (err instanceof Error) expect(err.message).toMatch(/cooling down/);
			expect(flowCalls).toBe(1);
			expect(skips).toEqual([
				expect.objectContaining({ lastOutcome: "timeout", remainingMinutes: 15 }),
			]);

			nowMs += 14 * 60_000;
			await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toThrow(/cooling down/);
			expect(flowCalls).toBe(1);

			nowMs += 2 * 60_000;
			await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toBeInstanceOf(
				NotLoggedInError,
			);
			expect(flowCalls).toBe(2);
		});

		test("a thrown flow also starts the cooldown", async () => {
			mockBackend();
			setAutoLogin({
				runFlow: async () => {
					flowCalls++;
					throw new Error("browser crashed");
				},
				now: () => nowMs,
			});
			await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toBeInstanceOf(
				NotLoggedInError,
			);
			await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toThrow(/cooling down/);
			expect(flowCalls).toBe(1);
		});

		test("a successful flow starts no cooldown", async () => {
			mockBackend();
			useFlow({ kind: "callback", url: callback });
			await gql(query, {}, ShoppingListsDataSchema);
			rmSync(path, { force: true });
			resetTokenCache();
			await gql(query, {}, ShoppingListsDataSchema);
			expect(flowCalls).toBe(2);
		});

		test("still unauthorized after a successful flow: one flow, two passes, then NotLoggedInError", async () => {
			writeTokens(future());
			mockBackend({ alwaysUnauthorized: true });
			useFlow({ kind: "callback", url: callback });
			await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toBeInstanceOf(
				NotLoggedInError,
			);
			expect(flowCalls).toBe(1);
			// Each pass is a try plus a token-renewal retry.
			expect(graphqlPosts).toBe(4);
		});

		test("transient errors start no flow", async () => {
			writeTokens(Math.floor(Date.now() / 1000) - 10);
			mockBackend({ refreshStatus: 502 });
			useFlow({ kind: "callback", url: callback });
			await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toThrow(/502/);
			writeTokens(future());
			resetTokenCache();
			mockFetch((call) =>
				call.body.includes("anonymousUserToken")
					? new Response(JSON.stringify({ data: { anonymousUserToken: "anon" } }))
					: new Response("Bad Gateway", { status: 503 }),
			);
			await expect(gql(query, {}, ShoppingListsDataSchema)).rejects.toThrow(/503/);
			expect(flowCalls).toBe(0);
		});

		// Every not-logged-in status says what to do, exactly once.
		test("getStatus adds the hint to a non-registered user, never twice", async () => {
			writeTokens(future());
			mockFetch((call) =>
				call.body.includes("anonymousUserToken")
					? new Response(JSON.stringify({ data: { anonymousUserToken: "anon" } }))
					: new Response(JSON.stringify({ data: { user: { id: "u", type: "ANONYMOUS_USER" } } })),
			);
			const anonymous = await getStatus();
			expect(anonymous.loggedIn).toBe(false);
			expect(anonymous.hint).toBe(LOGIN_HINT);

			mockBackend();
			useFlow({ kind: "needs_human", detail: "otp" });
			rmSync(path, { force: true });
			resetTokenCache();
			const expired = await getStatus();
			expect(expired.loggedIn).toBe(false);
			expect(expired.hint).toBeUndefined();
			expect(expired.error?.split(LOGIN_HINT)).toHaveLength(2);
		});

		test("getStatus logs in by itself when logged out", async () => {
			mockBackend();
			useFlow({ kind: "callback", url: callback });
			const verifiedUser = JSON.stringify({
				data: { user: { id: "u", type: "REGISTERED_USER", firstName: "A" } },
			});
			const inner = globalThis.fetch;
			globalThis.fetch = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) =>
					loggedIn && String(input).endsWith("/graphql")
						? new Response(verifiedUser)
						: inner(input, init),
				{ preconnect: realFetch.preconnect },
			);
			const status = await getStatus();
			expect(status.loggedIn).toBe(true);
			expect(flowCalls).toBe(1);
		});
	});

	// The browser half is the S-group session's (tested there with fakes); this
	// side maps its outcome and exchanges the callback nonce for tokens.
	describe("login", () => {
		const callback = "https://kirjautuminen.s-ostoslista.fi/callback?response=ok&nonce=n1";
		const flowReturning =
			(outcome: Awaited<ReturnType<RunLoginFlow>>): RunLoginFlow =>
			async () =>
				outcome;

		test("hands the flow a target whose callback matcher only accepts the final hop", async () => {
			let seen: Parameters<RunLoginFlow>[0] | null = null;
			await loginWith(async (target) => {
				seen = target;
				return { kind: "declined", reason: "blocked", detail: "x" };
			});
			expect(seen).not.toBeNull();
			if (!seen) return;
			const target: Parameters<RunLoginFlow>[0] = seen;
			expect(target.startUrl).toBe("https://kirjautuminen.s-ostoslista.fi/login");
			expect(target.isCallback(callback)).toBe(true);
			expect(target.isCallback("https://kirjautuminen.s-ostoslista.fi/callback?code=abc")).toBe(
				false,
			);
		});

		test("a handed-over login's late callback is exchanged and stored like a silent one", async () => {
			let seen: Parameters<RunLoginFlow>[0] | null = null;
			const outcome = await loginWith(async (target) => {
				seen = target;
				return { kind: "needs_human", detail: "page kept open" };
			});
			expect(outcome).toMatchObject({ ok: false, reason: "needs_human" });
			if (!seen) throw new Error("no target");
			const target: Parameters<RunLoginFlow>[0] = seen;

			const accessToken = fakeJwt({ exp: future() });
			mockFetch(
				() => new Response(JSON.stringify({ accessToken, idToken: "id", refreshToken: "r2" })),
			);
			expect(await target.exchangeCallback(callback)).toEqual({ ok: true });
			expect(calls[0]?.url).toBe("https://kirjautuminen.s-ostoslista.fi/verify");
			const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
			expect(stored).toMatchObject({ registered: { refreshToken: "r2", accessToken } });

			mockFetch(() => new Response(JSON.stringify({ error: "expired" }), { status: 400 }));
			const failed = await target.exchangeCallback(callback);
			expect(failed.ok).toBe(false);
			if (!failed.ok) expect(failed.detail).toContain("/verify HTTP 400");
		});

		test("exchanges the callback nonce at /verify and stores the tokens", async () => {
			const accessToken = fakeJwt({ exp: future() });
			mockFetch(
				() => new Response(JSON.stringify({ accessToken, idToken: "id", refreshToken: "r1" })),
			);
			const outcome = await loginWith(flowReturning({ kind: "callback", url: callback }));
			expect(outcome.ok).toBe(true);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("https://kirjautuminen.s-ostoslista.fi/verify");
			expect(calls[0]?.body).toBe(JSON.stringify("n1"));
			const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
			expect(stored).toMatchObject({ registered: { refreshToken: "r1", accessToken } });
		});

		test("needs_human says the SSO session expired; the hint is NotLoggedInError's", async () => {
			mockFetch(() => new Response("unexpected", { status: 500 }));
			const outcome = await loginWith(flowReturning({ kind: "needs_human", detail: "otp" }));
			expect(outcome).toMatchObject({ ok: false, reason: "needs_human" });
			if (!outcome.ok) {
				expect(outcome.detail).toContain("S-tunnus SSO session has expired");
				expect(new NotLoggedInError(outcome.detail).message).toContain("s_etukortti_login_*");
			}
			expect(LOGIN_HINT).toContain("s_etukortti_login_*");
			expect(LOGIN_HINT).not.toContain("s_ostoslista_login");
			expect(LOGIN_HINT).not.toMatch(/cancel/i);
			expect(calls).toHaveLength(0);
		});

		test("a blocked flow is needs_human; a human login in progress is etukortti_login_busy", async () => {
			const blocked = await loginWith(
				flowReturning({ kind: "declined", reason: "blocked", detail: "stopped at otp" }),
			);
			expect(blocked).toMatchObject({ ok: false, reason: "needs_human" });
			if (!blocked.ok) expect(blocked.detail).toContain("stopped at otp");
			const busy = await loginWith(
				flowReturning({ kind: "declined", reason: "login_in_progress", detail: "busy" }),
			);
			expect(busy).toMatchObject({ ok: false, reason: "etukortti_login_busy" });
			// Cancelling would throw away a code that has already been mailed.
			if (!busy.ok) {
				expect(busy.detail).toContain("Do not cancel");
				expect(busy.detail).not.toContain("finish or cancel");
			}
			const noEmail = await loginWith(
				flowReturning({ kind: "declined", reason: "no_saved_email", detail: "none" }),
			);
			expect(noEmail).toMatchObject({ ok: false, reason: "no_saved_email" });
		});

		test("IdP failures and a failed callback keep their reasons", async () => {
			const timeout = await loginWith(
				flowReturning({ kind: "failed", reason: "timeout", detail: "no callback" }),
			);
			expect(timeout).toMatchObject({ ok: false, reason: "timeout" });
			const expired = await loginWith(
				flowReturning({
					kind: "callback",
					url: "https://kirjautuminen.s-ostoslista.fi/callback?response=expired",
				}),
			);
			expect(expired).toMatchObject({ ok: false, reason: "callback_failed" });
		});
	});
});
