import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// A tool without annotations reads to clients as the spec's worst case
// (destructive, not idempotent), so a lookup looks as risky as a delete. Every
// register* export in src/tools/ is picked up, so a new tool file is covered
// without touching this test.
async function listAllTools() {
	const server = new McpServer({ name: "annotations-test", version: "0" });
	for (const file of new Bun.Glob("*.ts").scanSync(import.meta.dirname)) {
		if (file.endsWith(".test.ts")) continue;
		const mod: Record<string, unknown> = await import(`./${file}`);
		for (const [name, value] of Object.entries(mod)) {
			if (name.startsWith("register") && typeof value === "function") value(server);
		}
	}
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "annotations-test", version: "0" });
	await client.connect(clientTransport);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

test("every MCP tool declares a title and its read/write/destructive/open-world hints", async () => {
	const tools = await listAllTools();
	expect(tools.length).toBeGreaterThan(30);
	const missing = tools.flatMap((tool) => {
		const a = tool.annotations;
		const gaps = [
			tool.title === undefined && "title",
			typeof a?.readOnlyHint !== "boolean" && "readOnlyHint",
			a?.readOnlyHint === false && typeof a.destructiveHint !== "boolean" && "destructiveHint",
			typeof a?.openWorldHint !== "boolean" && "openWorldHint",
		].filter((g) => typeof g === "string");
		return gaps.length > 0 ? [`${tool.name}: ${gaps.join(", ")}`] : [];
	});
	expect(missing).toEqual([]);
});
