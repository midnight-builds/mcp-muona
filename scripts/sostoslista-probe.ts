// Runs one GraphQL document against the S-ostoslista API with the tokens the
// production service stored, to check that Muona's client may call an
// operation before a feature is built on it: the schema in the APK lists
// operations (products(eans), eslBlinkLabel) that answer "Not Authorized" for
// this client.
//
// It never refreshes: the refresh token rotates, so refreshing here would log
// the service out. An expired access token is reported instead; any
// S-ostoslista tool call (e.g. s_ostoslista_status) through the service renews it.
//
// Usage: bun run scripts/sostoslista-probe.ts [--auth user|anon|api-key] '<document>' ['<variables json>']
// Probe a mutation where it cannot take effect (e.g. eslBlinkLabel in a store
// whose eslIsEnabled is false): the error still tells whether it is authorized.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod/v4";
import { API_URL, buildAuthorization, decodeJwtExpiry } from "../src/browser/s-ostoslista.ts";

const say = (msg: string) => process.stdout.write(`${msg}\n`);

const TokenFileSchema = z.object({
	anonymousToken: z.string().min(1),
	registered: z.object({ accessToken: z.string().min(1) }).nullish(),
});

const AuthSchema = z.enum(["user", "anon", "api-key"]);

// Worktrees have no data/; the tokens live in the main checkout.
function mainCheckout(): string {
	const out = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (out.exitCode !== 0) throw new Error("not inside the Muona git repository");
	return dirname(out.stdout.toString().trim());
}

function readEnvValue(file: string, key: string): string | null {
	const line = readFileSync(file, "utf8")
		.split("\n")
		.find((l) => l.startsWith(`${key}=`));
	return line ? line.slice(key.length + 1).trim() : null;
}

function parseArgs(argv: string[]) {
	const rest = [...argv];
	let auth: z.infer<typeof AuthSchema> = "user";
	const flag = rest.indexOf("--auth");
	if (flag !== -1) {
		auth = AuthSchema.parse(rest[flag + 1]);
		rest.splice(flag, 2);
	}
	const [query, variablesJson] = rest;
	if (!query)
		throw new Error(
			"usage: sostoslista-probe.ts [--auth user|anon|api-key] '<document>' ['<variables json>']",
		);
	const variables = z.record(z.string(), z.unknown()).parse(JSON.parse(variablesJson ?? "{}"));
	return { auth, query, variables };
}

async function main(): Promise<void> {
	const { auth, query, variables } = parseArgs(process.argv.slice(2));
	const root = mainCheckout();
	const tokens = TokenFileSchema.parse(
		JSON.parse(readFileSync(join(root, "data", "s-ostoslista-tokens.json"), "utf8")),
	);
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (auth === "api-key") {
		const key = readEnvValue(join(root, ".env"), "S_OSTOSLISTA_API_KEY");
		if (!key) throw new Error("S_OSTOSLISTA_API_KEY missing from .env");
		headers["x-api-key"] = key;
	} else {
		const access = auth === "user" ? (tokens.registered?.accessToken ?? null) : null;
		if (auth === "user") {
			const exp = access ? decodeJwtExpiry(access) : null;
			if (!access || exp === null || exp * 1000 <= Date.now()) {
				throw new Error(
					"No valid access token. Call s_ostoslista_status through the service to renew it; " +
						"this script never refreshes.",
				);
			}
		}
		headers.authorization = buildAuthorization(tokens.anonymousToken, access);
	}
	const res = await fetch(API_URL, {
		method: "POST",
		headers,
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(20_000),
	});
	say(`HTTP ${res.status} (auth: ${auth})`);
	say(await res.text());
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
