import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	fetchPastProducts,
	fetchShoppingLists,
	getStatus,
	type ShoppingList,
} from "../browser/s-ostoslista.ts";
import { type Product, shoppingListApi } from "../browser/s-ostoslista-lists.ts";
import { ok, run } from "./tool-result.ts";

const LOGIN_NOTE =
	"Logs in automatically while the S-tunnus SSO session is alive; otherwise errors that the " +
	"human must finish the S-Etukortti login (s_etukortti_login_*).";

const ItemInputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.optional()
			.describe("Free-text item, e.g. 'maito'. With an ean, overrides the product name."),
		ean: z
			.string()
			.regex(/^\d{8,14}$/)
			.optional()
			.describe("Add as a store product (price, aisle). Must exist in the list's store."),
		quantity: z.number().positive().optional().describe("Product items only; default 1"),
		quantityUnit: z
			.string()
			.min(1)
			.optional()
			.describe("Product items only; default the product's price unit, e.g. KPL or KG"),
	})
	.refine((i) => i.name !== undefined || i.ean !== undefined, "Each item needs a name or an ean");

function summarizeProduct(p: Product) {
	return {
		id: p.id ?? null,
		name: p.name ?? null,
		ean: p.ean ?? null,
		brand: p.brandName ?? null,
		available: p.available ?? null,
		price: p.pricing?.currentPrice ?? null,
		regularPrice: p.pricing?.regularPrice ?? null,
		comparisonPrice: p.pricing?.comparisonPrice ?? null,
		comparisonUnit: p.comparisonUnit ?? null,
		priceUnit: p.priceUnit ?? null,
		aisle: p.location?.aisle ?? null,
	};
}

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

	server.registerTool(
		"get_shopping_list",
		{
			description: `One S-ostoslista shopping list by id, with its items. Read-only. ${LOGIN_NOTE}`,
			inputSchema: z.object({ listId: z.string().min(1) }),
		},
		async ({ listId }) =>
			run("Error fetching shopping list", async () => {
				return ok(summarizeList(await shoppingListApi.fetchShoppingList(listId), true));
			}),
	);

	server.registerTool(
		"search_shopping_list_products",
		{
			description:
				"Search products in one store's S-ostoslista assortment, to get the ean to add an item " +
				"as a product (with price and aisle) rather than free text. Read-only. storeId is a SOK " +
				`store id, e.g. a shopping list's store.id. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				storeId: z.string().min(1),
				query: z.string().min(1),
				limit: z.number().int().min(1).max(50).default(10),
			}),
		},
		async ({ storeId, query, limit }) =>
			run("Error searching products", async () => {
				const { products, maybeHasMore } = await shoppingListApi.searchProducts(
					storeId,
					query,
					limit,
				);
				return ok({ storeId, query, maybeHasMore, products: products.map(summarizeProduct) });
			}),
	);

	server.registerTool(
		"create_shopping_list",
		{
			description:
				"Create a new S-ostoslista shopping list in a store, optionally with items. Items with " +
				"an ean are looked up in that store first; if any ean is not found, nothing is created. " +
				`Only edits the list in the app — never orders anything. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				name: z.string().min(1),
				storeId: z.string().min(1).describe("SOK store id the list is for"),
				items: z.array(ItemInputSchema).max(200).default([]),
			}),
		},
		async ({ name, storeId, items }) =>
			run("Error creating shopping list", async () => {
				const list = await shoppingListApi.createShoppingList({
					name,
					storeId,
					mode: "PLAN",
					items,
				});
				return ok(summarizeList(list, true));
			}),
	);

	server.registerTool(
		"add_shopping_list_items",
		{
			description:
				"Add items to an existing S-ostoslista shopping list. Free-text items need only a name; " +
				"items with an ean are looked up in the list's store, and if any ean is not found nothing " +
				`is added. Returns the updated list. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				listId: z.string().min(1),
				items: z.array(ItemInputSchema).min(1).max(200),
			}),
		},
		async ({ listId, items }) =>
			run("Error adding shopping list items", async () => {
				return ok(summarizeList(await shoppingListApi.addItems(listId, items), true));
			}),
	);

	server.registerTool(
		"update_shopping_list_items",
		{
			description:
				"Update items on an S-ostoslista shopping list: mark collected/uncollected, rename, or " +
				"change quantity. Item ids come from get_shopping_list; ids not on the list abort the " +
				`whole update. Returns the updated list. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				listId: z.string().min(1),
				updates: z
					.array(
						z.object({
							itemId: z.string().min(1),
							collected: z.boolean().optional(),
							name: z.string().min(1).optional(),
							quantity: z.number().positive().optional(),
							quantityUnit: z.string().min(1).optional(),
						}),
					)
					.min(1)
					.max(200),
			}),
		},
		async ({ listId, updates }) =>
			run("Error updating shopping list items", async () => {
				return ok(summarizeList(await shoppingListApi.updateItems(listId, updates), true));
			}),
	);

	server.registerTool(
		"remove_shopping_list_items",
		{
			description:
				"Remove items from an S-ostoslista shopping list by item id (from get_shopping_list). " +
				`Ids not on the list abort the whole removal. Returns the updated list. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				listId: z.string().min(1),
				itemIds: z.array(z.string().min(1)).min(1).max(200),
			}),
		},
		async ({ listId, itemIds }) =>
			run("Error removing shopping list items", async () => {
				return ok(summarizeList(await shoppingListApi.removeItems(listId, itemIds), true));
			}),
	);

	server.registerTool(
		"delete_shopping_list",
		{
			description:
				"Permanently delete an S-ostoslista shopping list. For a list shared with others this " +
				"may delete it for them too. Cannot be undone — only do this when the user asked for it. " +
				LOGIN_NOTE,
			inputSchema: z.object({ listId: z.string().min(1) }),
		},
		async ({ listId }) =>
			run("Error deleting shopping list", async () => {
				return ok({ deleted: await shoppingListApi.deleteShoppingList(listId) });
			}),
	);

	server.registerTool(
		"share_shopping_list",
		{
			description:
				"Create a share link (https://s-ostoslista.fi/liity/…) for an S-ostoslista list. Lists " +
				"belong to a device identity, not the S-tunnus, so this is how the user gets a list Muona " +
				"made onto their phone: they open the link in the S-ostoslista app. Anyone with the link " +
				`can join with the given permissions until it expires. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				listId: z.string().min(1),
				permissions: z
					.array(z.enum(["READ", "WRITE", "SHARE"]))
					.min(1)
					.default(["READ", "WRITE"])
					.describe("READ to view, WRITE to edit, SHARE to re-share"),
				validForHours: z.number().int().min(1).max(8760).default(24),
			}),
		},
		async ({ listId, permissions, validForHours }) =>
			run("Error sharing shopping list", async () => {
				const url = await shoppingListApi.shareShoppingList(
					listId,
					[...new Set(permissions)],
					validForHours,
				);
				return ok({ listId, url, permissions, validForHours });
			}),
	);

	server.registerTool(
		"claim_shared_shopping_list",
		{
			description:
				"Join an S-ostoslista list someone shared (e.g. the user's own list from their phone: " +
				"Jaa → link). Takes the share link, the whole share message, or the link id. Lists " +
				"belong to a device identity, not the S-tunnus, so the user's phone lists are only " +
				`visible to Muona after this. Returns the joined list. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				link: z.string().min(1).describe("https://s-ostoslista.fi/liity/<id>, or the id"),
			}),
		},
		async ({ link }) =>
			run("Error joining shared shopping list", async () => {
				return ok(summarizeList(await shoppingListApi.claimSharedShoppingList(link), true));
			}),
	);
}
