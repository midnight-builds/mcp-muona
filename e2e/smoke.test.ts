import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Smoke test against the built bundle: the one thing that must never regress
// is that /mcp refuses requests without the bearer token. Every data path
// points into a scratch directory so a run can never touch the production
// browser profile or purchase database, and warmup is skipped so CI does not
// open browsers against the live store sites.

const bundle = join(import.meta.dirname, "..", "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "muona-smoke-"));
const token = randomBytes(32).toString("hex");
const port = 40_000 + Math.floor(Math.random() * 10_000);
const url = `http://127.0.0.1:${port}/mcp`;

let server: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
	if (!(await Bun.file(bundle).exists())) {
		throw new Error(`${bundle} missing — run \`bun run build\` first`);
	}
	server = Bun.spawn(["bun", bundle], {
		// A scratch cwd keeps Bun from auto-loading the repo's .env (production
		// token and port) into the server under test.
		cwd: scratch,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: scratch,
			PORT: String(port),
			MCP_AUTH_TOKEN: token,
			MUONA_SKIP_WARMUP: "1",
			LOG_LEVEL: "warn",
			BROWSER_DATA_DIR: join(scratch, "browser"),
			S_ETUKORTTI_DATA_DIR: join(scratch, "s-etukortti"),
			S_OSTOSLISTA_TOKEN_PATH: join(scratch, "s-ostoslista-tokens.json"),
			MUONA_DB_PATH: join(scratch, "receipts.sqlite"),
		},
		stdout: "ignore",
		stderr: "inherit",
	});
	for (let i = 0; i < 100; i++) {
		try {
			await fetch(url);
			return;
		} catch {
			await Bun.sleep(100);
		}
	}
	throw new Error(`server did not start listening on ${url}`);
}, 20_000);

afterAll(() => {
	server?.kill();
	rmSync(scratch, { recursive: true, force: true });
});

const initialize = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "smoke", version: "0" },
	},
});

function post(headers: Record<string, string>): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: initialize,
	});
}

test("rejects requests without a token", async () => {
	expect((await post({})).status).toBe(401);
});

test("rejects requests with a wrong token", async () => {
	expect((await post({ authorization: `Bearer ${token.slice(1)}x` })).status).toBe(401);
});

test("initializes an MCP session with the right token", async () => {
	const res = await post({ authorization: `Bearer ${token}` });
	expect(res.status).toBe(200);
	expect(res.headers.get("mcp-session-id")).toBeTruthy();
	expect(await res.text()).toContain('"name":"muona"');
});
