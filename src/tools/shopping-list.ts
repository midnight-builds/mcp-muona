import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	fetchPastProducts,
	fetchShoppingLists,
	getStatus,
	type ShoppingList,
} from "../browser/s-ostoslista.ts";
import {
	APP_SHARE_PERMISSIONS,
	type Product,
	shoppingListApi,
} from "../browser/s-ostoslista-lists.ts";
import { DESTRUCTIVE, READ, WRITE } from "./annotations.ts";
import { ok, run } from "./tool-result.ts";

const LOGIN_NOTE =
	"Logs in automatically while the S-tunnus SSO session is alive; otherwise errors that the " +
	"human must finish the S-Etukortti login (s_etukortti_login_*).";

// Every S-ostoslista tool's title starts with the app name, for clients that
// list tools flat.

const ItemInputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Product item: the product's name exactly as search_shopping_list_products returned it " +
					"(required with ean). Free-text item: the text alone, e.g. 'maito'.",
			),
		ean: z
			.string()
			.regex(/^\d{8,14}$/)
			.optional()
			.describe(
				"ean from search_shopping_list_products in the list's store; makes a product item with " +
					"price and aisle. Give the product name too.",
			),
		quantity: z.number().positive().optional().describe("Product items only; default 1"),
		quantityUnit: z
			.string()
			.min(1)
			.optional()
			.describe("Product items only; default the product's price unit, e.g. KPL or KG"),
	})
	.refine((i) => i.name !== undefined || i.ean !== undefined, "Each item needs a name or an ean");

function packageSize(p: Product): string | null {
	const weight = p.measurement?.netWeight;
	if (weight == null) return null;
	return p.measurement?.netWeightUnit ? `${weight} ${p.measurement.netWeightUnit}` : `${weight}`;
}

function summarizeProduct(p: Product) {
	return {
		id: p.id ?? null,
		name: p.name ?? null,
		packageSize: packageSize(p),
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
			title: "S-ostoslista: login status",
			annotations: READ,
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
			title: "S-ostoslista: list shopping lists",
			annotations: READ,
			description:
				"List the user's S-ostoslista shopping lists (S-ryhmä's shopping list app), including " +
				"lists shared with them (`shared`, `permissions`). Start here: it gives each list's id " +
				"and store.id, which the search and edit tools need. Read-only. Logs in automatically while the S-tunnus SSO " +
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
			title: "S-ostoslista: previously bought products",
			annotations: READ,
			description:
				"S-ostoslista's own view of products the user has bought before in a given store " +
				"(`totalCount`, `latestQuantity`, `isWeeklyProduct`), each with its name and ean, which " +
				"add_shopping_list_items takes as they are. Read-only. storeId is a SOK store " +
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
			title: "S-ostoslista: one shopping list",
			annotations: READ,
			description:
				"One S-ostoslista shopping list by id, with its items: item ids for " +
				"update_shopping_list_items and remove_shopping_list_items, and whether each item is a " +
				`product (ean, price, aisle) or free text. Read-only. ${LOGIN_NOTE}`,
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
			title: "S-ostoslista: search a store's products",
			annotations: READ,
			description:
				"Search one store's assortment for products to put on an S-ostoslista list. This is the " +
				"search for shopping lists; search_products is for the K-Ruoka/S-Kaupat/Alko web " +
				"catalogs. Typical chain: get_shopping_lists → the list's store.id → search here, e.g. " +
				"'Löfbergs Lila' → pick the result that matches size and variant (whole bean vs " +
				"ground etc. is in the name; packageSize when the store gives it) → " +
				"add_shopping_list_items with that result's ean and name. When several results fit " +
				`and the user did not say which, ask or state your pick. Read-only. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				storeId: z.string().min(1).describe("SOK store id: the list's store.id"),
				query: z.string().min(1).describe("Product name, brand or kind, e.g. 'rasvaton maito'"),
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
			title: "S-ostoslista: create a list",
			annotations: WRITE,
			description:
				"Create a new S-ostoslista shopping list in a store, optionally with items (product vs " +
				"free-text items as in add_shopping_list_items). Product items are checked in that store first; if " +
				"any is not found, nothing is created. The list belongs to Muona's device: use " +
				"share_shopping_list to get it onto the user's phone. Only edits the list in the app — " +
				`never orders anything. ${LOGIN_NOTE}`,
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
			title: "S-ostoslista: add items",
			annotations: WRITE,
			description:
				"Add items to an S-ostoslista shopping list. When the user means a particular product " +
				"(brand, size, variant), search it first with search_shopping_list_products and add " +
				"it by ean + name: that gives price and aisle in the app. Use a free-text item (name " +
				"only) only for generic things the user did not tie to a product, e.g. 'leipää'. " +
				"Quantity works only on product items; the same item twice in one call is refused. Product items are checked in the list's store; " +
				"if any is not found, nothing is added. An open (uncollected) item already on the " +
				"list — same ean, or the same text for free text — is not added again but returned " +
				"in alreadyOnList: raise its quantity (requestedQuantity) with " +
				"update_shopping_list_items if more is wanted, or set allowDuplicates for a second row. Collected items do not count. " +
				"Overlaps that are not exact (e.g. 'maito' when 'Kotimaista rasvaton maito 1 l' is " +
				"on the list) are added and listed in similarOnList — tell the user. Returns " +
				`added, alreadyOnList, similarOnList and the updated list. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				listId: z.string().min(1).describe("List id from get_shopping_lists"),
				items: z.array(ItemInputSchema).min(1).max(200),
				allowDuplicates: z
					.boolean()
					.default(false)
					.describe("Add items even when the same item is already open on the list"),
			}),
		},
		async ({ listId, items, allowDuplicates }) =>
			run("Error adding shopping list items", async () => {
				const result = await shoppingListApi.addItems(listId, items, { allowDuplicates });
				return ok({
					added: result.added,
					alreadyOnList: result.alreadyOnList.map((d) => ({
						requested: d.input.name ?? d.input.ean ?? null,
						requestedQuantity: d.input.quantity ?? null,
						itemId: d.itemId,
						name: d.name,
						quantity: d.quantity,
					})),
					similarOnList: result.similarOnList,
					list: summarizeList(result.list, true),
				});
			}),
	);

	server.registerTool(
		"update_shopping_list_items",
		{
			title: "S-ostoslista: update items",
			annotations: WRITE,
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
			title: "S-ostoslista: remove items",
			annotations: DESTRUCTIVE,
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
			title: "S-ostoslista: delete a list",
			annotations: DESTRUCTIVE,
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
			title: "S-ostoslista: share a list",
			annotations: WRITE,
			description:
				"Create a share link (https://s-ostoslista.fi/liity/…) for an S-ostoslista list. Lists " +
				"belong to a device identity, not the S-tunnus, so this is how the user gets a list Muona " +
				"made onto their phone: they open the link in the S-ostoslista app. Like the app's own " +
				"share, anyone with the link can view, edit and re-share the list until the link " +
				`expires. ${LOGIN_NOTE}`,
			inputSchema: z.object({
				listId: z.string().min(1),
				validForHours: z.number().int().min(1).max(8760).default(24),
			}),
		},
		async ({ listId, validForHours }) =>
			run("Error sharing shopping list", async () => {
				const url = await shoppingListApi.shareShoppingList(
					listId,
					[...APP_SHARE_PERMISSIONS],
					validForHours,
				);
				return ok({ listId, url, permissions: APP_SHARE_PERMISSIONS, validForHours });
			}),
	);

	server.registerTool(
		"claim_shared_shopping_list",
		{
			title: "S-ostoslista: join a shared list",
			annotations: WRITE,
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
