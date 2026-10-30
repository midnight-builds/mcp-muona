import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	fetchPastProducts,
	fetchShoppingLists,
	getStatus,
	type ShoppingList,
} from "../browser/s-ostoslista.ts";
import { ok, run } from "./tool-result.ts";

// Flattens the two item variants (free-text vs product-resolved) so the agent
// doesn't need to know the GraphQL union.
function summarizeList(list: ShoppingList, includeItems: boolean) {
	const collected = list.items.filter((i) => i.collected).length;
	return {
		id: list.id,
		name: list.name,
		mode: list.mode,
		store: list.store ?? (list.storeId ? { id: list.storeId } : null),
		shared: list.shared,
		permissions: list.permissions,
		modifiedAt: list.modifiedAt,
		itemCount: list.items.length,
		collectedCount: collected,
		items: includeItems
			? list.items.map((item) => ({
					id: item.id,
					name: item.name,
					collected: item.collected ?? false,
					ean: item.ean ?? item.products?.[0]?.ean ?? null,
					quantity: item.quantity ?? item.products?.[0]?.quantity ?? null,
					quantityUnit: item.quantityUnit ?? null,
					price: item.product?.pricing?.currentPrice ?? null,
					aisle: item.product?.location?.aisle ?? null,
				}))
			: undefined,
	};
}

export function registerShoppingListTools(server: McpServer): void {
	server.registerTool(
		"s_ostoslista_status",
		{
			description:
				"Check whether the S-ostoslista login is valid (verified with a live `user` query, " +
				"refreshing the token if needed) and when the access token expires. Logs in " +
				"automatically while the S-tunnus SSO session is alive; when that is impossible " +
				"the result says the human must finish the S-Etukortti login (s_etukortti_login_*).",
			inputSchema: z.object({}),
		},
		async () =>
			run("Error checking S-ostoslista status", async () => {
				return ok(await getStatus());
			}),
	);

	server.registerTool(
		"get_shopping_lists",
		{
			description:
				"List the user's S-ostoslista shopping lists, including lists shared with them " +
				"(`shared`, `permissions`). Read-only. Logs in automatically while the S-tunnus SSO " +
				"session is alive; otherwise errors that the human must finish the S-Etukortti " +
				"login (s_etukortti_login_*). Items are flattened: free-text items have only " +
				"a name, product-resolved items also carry ean, quantity, current price and aisle.",
			inputSchema: z.object({
				includeItems: z.boolean().default(true).describe("Include the items of each list"),
			}),
		},
		async ({ includeItems }) =>
			run("Error fetching shopping lists", async () => {
				const lists = await fetchShoppingLists();
				return ok({ count: lists.length, lists: lists.map((l) => summarizeList(l, includeItems)) });
			}),
	);

	server.registerTool(
		"get_past_products",
		{
			description:
				"S-ostoslista's own view of products the user has bought before in a given store " +
				"(`totalCount`, `latestQuantity`, `isWeeklyProduct`). Read-only. storeId is a SOK store " +
				"id — e.g. the store of an existing shopping list from get_shopping_lists. Logs in " +
				"automatically while the S-tunnus SSO session is alive; otherwise errors that the " +
				"human must finish the S-Etukortti login (s_etukortti_login_*).",
			inputSchema: z.object({
				storeId: z.string().min(1).describe("SOK store id, e.g. a shopping list's store.id"),
				limit: z.number().int().min(1).max(500).default(100),
			}),
		},
		async ({ storeId, limit }) =>
			run("Error fetching past products", async () => {
				const products = await fetchPastProducts(storeId);
				const sorted = [...products].sort((a, b) => b.totalCount - a.totalCount);
				return ok({
					storeId,
					total: products.length,
					weeklyCount: products.filter((p) => p.isWeeklyProduct).length,
					products: sorted.slice(0, limit).map((p) => ({
						name: p.product.name,
						ean: p.product.ean,
						totalCount: p.totalCount,
						latestQuantity: p.latestQuantity,
						isWeeklyProduct: p.isWeeklyProduct,
						price: p.product.pricing?.currentPrice ?? null,
						aisle: p.product.location?.aisle ?? null,
					})),
				});
			}),
	);
}
