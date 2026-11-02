import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
	createAuthCode,
	exchangeAuthCode,
	isKnownClientId,
	issueAccessToken,
	oauthEnabled,
	validateAccessToken,
	validateClientCredentials,
	validateRefreshToken,
} from "./auth.ts";
import { startAutoSync } from "./auto-sync.ts";
import { warmup as warmupAlko } from "./browser/alko.ts";
import { sGroup } from "./browser/s-group/index.ts";
import { warmup as warmupSKaupat } from "./browser/s-kaupat.ts";
import { getPage } from "./browser/session.ts";
import { logger } from "./logger.ts";
import { registerAutoSyncTools } from "./tools/auto-sync.ts";
import { registerCouponsTools } from "./tools/coupons.ts";
import { registerHistoryTools } from "./tools/history.ts";
import { registerLoginTools } from "./tools/login.ts";
import { registerReceiptTools } from "./tools/receipts.ts";
import { registerSearchTool } from "./tools/search.ts";
import { registerShoppingListTools } from "./tools/shopping-list.ts";
import { registerStoresTool } from "./tools/stores.ts";

const logoPath = join(import.meta.dirname, "..", "logo.png");
const logoDataUri = `data:image/png;base64,${Buffer.from(await Bun.file(logoPath).arrayBuffer()).toString("base64")}`;

// Clients list the tools flat, so this is where the groups and the multi-tool
// workflows are spelled out; the shopping-list chain in particular is easy to
// miss from the individual descriptions.
const INSTRUCTIONS = `Muona: Finnish grocery tools in three groups.

1. S-ostoslista — S-ryhmä's shopping list app (the user's own lists). Tools: get_shopping_lists, get_shopping_list, search_shopping_list_products, add_shopping_list_items, update_shopping_list_items, remove_shopping_list_items, create_shopping_list, delete_shopping_list, share_shopping_list, claim_shared_shopping_list, get_past_products, s_ostoslista_status.
   Adding a product: get_shopping_lists (list id + store.id) → search_shopping_list_products(storeId, query) → pick the result matching size and variant → add_shopping_list_items(listId, [{ ean, name, quantity }]) with that result's ean and name → read added / alreadyOnList / similarOnList in the result.
   Use free-text items (name only) only for generic things the user did not tie to a product. Items already open on the list are not added twice; raise their quantity with update_shopping_list_items instead.
   Lists belong to a device, not the S-tunnus: the user's phone lists appear after claim_shared_shopping_list with their share link; lists Muona makes reach the phone via share_shopping_list. Nothing here ever places an order.

2. Web store catalogs — get_stores, search_products: K-Ruoka, S-Kaupat and Alko product search. Not for shopping lists; use search_shopping_list_products there.

3. S-Etukortti — receipts, purchase history, bonus, coupons and discounts (get_receipts, sync_receipts, search_purchases, purchase_history_stats, get_bonus_*, get_coupons, ...). Needs a login the human finishes (email code or bank ID) via the s_etukortti_login_* tools; never try to get past those steps yourself.`;

function createServer(): McpServer {
	const server = new McpServer(
		{
			name: "muona",
			version: "0.3.0",
			icons: [{ src: logoDataUri, mimeType: "image/png", sizes: ["512x512"] }],
		},
		{ instructions: INSTRUCTIONS },
	);
	registerSearchTool(server);
	registerStoresTool(server);
	registerReceiptTools(server);
	registerLoginTools(server);
	registerHistoryTools(server);
	registerCouponsTools(server);
	registerAutoSyncTools(server);
	registerShoppingListTools(server);
	return server;
}

// Pre-warm all sessions so the first request isn't slow. The S-Etukortti probe
// also starts the keepalive timer right away when a stored login exists, instead
// of only after the first receipt tool call.
function warmupAll(): void {
	getPage().catch((err) => {
		logger.warn({ err }, "K-Ruoka pre-init failed (will retry on first request)");
	});
	warmupSKaupat().catch((err) => {
		logger.warn({ err }, "S-Kaupat pre-init failed (will retry on first request)");
	});
	warmupAlko().catch((err) => {
		logger.warn({ err }, "Alko pre-init failed (will retry on first request)");
	});
	sGroup
		.probe()
		.then((status) => {
			logger.info({ loggedIn: status.loggedIn }, "S-Etukortti session warmup");
		})
		.catch((err) => {
			logger.warn({ err }, "S-Etukortti warmup failed (will retry on first request)");
		});

	// Idempotent and synchronous (just arms a 60s interval), so it's safe to
	// call from both the stdio and HTTP startup paths without awaiting.
	try {
		startAutoSync();
	} catch (err) {
		logger.warn({ err }, "Auto-sync scheduler failed to start (will retry on next warmup)");
	}
}

if (process.argv.includes("--stdio")) {
	logger.info("Starting in stdio mode");
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	warmupAll();
} else {
	startHttpServer();
}

function startHttpServer() {
	interface TrackedTransport {
		transport: WebStandardStreamableHTTPServerTransport;
		lastActivity: number;
	}

	const transports = new Map<string, TrackedTransport>();
	const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

	function getTransport(
		sessionId: string | null,
	): WebStandardStreamableHTTPServerTransport | undefined {
		if (!sessionId) return undefined;
		const entry = transports.get(sessionId);
		if (!entry) return undefined;
		entry.lastActivity = Date.now();
		return entry.transport;
	}

	setInterval(() => {
		const cutoff = Date.now() - SESSION_TTL;
		for (const [id, entry] of transports) {
			if (entry.lastActivity < cutoff) {
				logger.info({ sessionId: id }, "Expiring idle MCP session");
				entry.transport.close?.();
				transports.delete(id);
			}
		}
	}, 60_000);

	const port = Number(process.env.PORT) || 3001;
	const authToken = process.env.MCP_AUTH_TOKEN;

	if (!authToken && !oauthEnabled) {
		logger.warn("No authentication configured — running without auth");
	}

	function checkAuth(req: Request): boolean {
		if (!authToken && !oauthEnabled) return true;

		const header = req.headers.get("authorization");
		if (!header?.startsWith("Bearer ")) return false;
		const token = header.slice(7);

		if (
			authToken &&
			token.length === authToken.length &&
			timingSafeEqual(Buffer.from(token), Buffer.from(authToken))
		) {
			return true;
		}
		return oauthEnabled && validateAccessToken(token);
	}

	function getBaseUrl(req: Request): string {
		const proto = req.headers.get("x-forwarded-proto") ?? "http";
		const host = req.headers.get("host") ?? `localhost:${port}`;
		return `${proto}://${host}`;
	}

	function handleOAuthDiscovery(req: Request, url: URL): Response | null {
		const base = getBaseUrl(req);
		switch (url.pathname) {
			case "/.well-known/oauth-protected-resource":
				return Response.json({
					resource: `${base}/mcp`,
					authorization_servers: [base],
					bearer_methods_supported: ["header"],
				});
			case "/.well-known/oauth-authorization-server":
				return Response.json({
					issuer: base,
					authorization_endpoint: `${base}/authorize`,
					token_endpoint: `${base}/token`,
					token_endpoint_auth_methods_supported: ["client_secret_post"],
					grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
			default:
				return null;
		}
	}

	function handleAuthorize(url: URL): Response {
		const responseType = url.searchParams.get("response_type");
		const id = url.searchParams.get("client_id");
		const redirectUri = url.searchParams.get("redirect_uri");
		const state = url.searchParams.get("state");
		const codeChallenge = url.searchParams.get("code_challenge");
		const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";

		if (
			responseType !== "code" ||
			!id ||
			!redirectUri ||
			!codeChallenge ||
			codeChallengeMethod !== "S256"
		) {
			return Response.json({ error: "invalid_request" }, { status: 400 });
		}
		if (!isKnownClientId(id)) {
			return Response.json({ error: "invalid_client" }, { status: 401 });
		}

		const code = createAuthCode({
			codeChallenge,
			codeChallengeMethod,
			redirectUri,
			clientId: id,
		});
		const redirect = new URL(redirectUri);
		redirect.searchParams.set("code", code);
		if (state) redirect.searchParams.set("state", state);
		return Response.redirect(redirect.toString(), 302);
	}

	async function handleToken(req: Request): Promise<Response> {
		const params = new URLSearchParams(await req.text());
		switch (params.get("grant_type")) {
			case "authorization_code": {
				const code = params.get("code");
				const codeVerifier = params.get("code_verifier");
				const redirectUri = params.get("redirect_uri");
				const id = params.get("client_id");
				if (!code || !codeVerifier || !redirectUri || !id) {
					return Response.json({ error: "invalid_request" }, { status: 400 });
				}

				const token = exchangeAuthCode({ code, codeVerifier, redirectUri, clientId: id });
				if (!token) {
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				}
				return Response.json(token);
			}

			case "client_credentials": {
				const id = params.get("client_id");
				const secret = params.get("client_secret");
				if (!id || !secret || !validateClientCredentials(id, secret)) {
					return Response.json({ error: "invalid_client" }, { status: 401 });
				}
				return Response.json(issueAccessToken());
			}

			case "refresh_token": {
				const refreshToken = params.get("refresh_token");
				if (!refreshToken || !validateRefreshToken(refreshToken)) {
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				}
				return Response.json(issueAccessToken());
			}

			default:
				return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
		}
	}

	async function handleOAuthRoutes(req: Request, url: URL): Promise<Response | null> {
		if (req.method === "GET") {
			const discovery = handleOAuthDiscovery(req, url);
			if (discovery) return discovery;
			if (url.pathname === "/authorize") return handleAuthorize(url);
		}
		if (req.method === "POST" && url.pathname === "/token") return handleToken(req);
		return null;
	}

	async function handleMcp(req: Request): Promise<Response> {
		const sessionId = req.headers.get("mcp-session-id");

		if (req.method === "POST") {
			const existing = getTransport(sessionId);
			if (existing) return existing.handleRequest(req);

			// Per MCP spec, 404 tells the client to re-initialize
			if (sessionId) {
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
					{ status: 404 },
				);
			}

			const body = await req.json();
			if (!isInitializeRequest(body)) {
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: null },
					{ status: 400 },
				);
			}

			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sid) => {
					logger.info({ sessionId: sid }, "New MCP session initialized");
					transports.set(sid, { transport, lastActivity: Date.now() });
				},
			});
			transport.onclose = () => {
				if (transport.sessionId) transports.delete(transport.sessionId);
			};

			const server = createServer();
			await server.connect(transport);

			return transport.handleRequest(
				new Request(req.url, {
					method: req.method,
					headers: req.headers,
					body: JSON.stringify(body),
				}),
			);
		}

		if (req.method === "GET" || req.method === "DELETE") {
			const transport = getTransport(sessionId);
			if (transport) return transport.handleRequest(req);
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
				{ status: sessionId ? 404 : 400 },
			);
		}

		return new Response("Method Not Allowed", { status: 405 });
	}

	Bun.serve({
		hostname: "0.0.0.0",
		port,
		// Long-running login tool calls (strong-auth wait) can hold a request
		// open for minutes; 255 is Bun's maximum.
		idleTimeout: 255,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			logger.debug({ method: req.method, path: url.pathname }, "Incoming request");

			if (oauthEnabled) {
				const oauthResponse = await handleOAuthRoutes(req, url);
				if (oauthResponse) return oauthResponse;
			}

			if (url.pathname === "/logo.png") return new Response(Bun.file(logoPath));
			if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });

			if (!checkAuth(req)) {
				logger.warn({ method: req.method, path: url.pathname }, "Auth rejected");
				const headers: Record<string, string> = {};
				if (oauthEnabled) {
					const base = getBaseUrl(req);
					headers["WWW-Authenticate"] =
						`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
				}
				return new Response(null, { status: 401, headers });
			}

			return handleMcp(req);
		},
	});

	logger.info({ port, url: `http://localhost:${port}/mcp` }, "Ruoka MCP server listening");

	// The e2e smoke test only exercises HTTP and auth; warming up would open
	// browsers against the live store sites and the S-Etukortti IdP.
	if (process.env.MUONA_SKIP_WARMUP === "1") {
		logger.info("Warmup skipped (MUONA_SKIP_WARMUP=1)");
		return;
	}
	warmupAll();
}
