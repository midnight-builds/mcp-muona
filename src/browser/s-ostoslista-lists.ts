// Shopping-list reads and writes on top of the S-ostoslista client. Mutation
// shapes come from the schema shipped in the APK
// (data-capture/s-ostoslista/schema.graphql); the Scan & Go, ESL and
// recommendation-feedback operations are deliberately left out.

import * as z from "zod/v4";
import { logger } from "../logger.ts";
import {
	gql,
	PRODUCT_FIELDS,
	ProductSchema,
	SHOPPING_LIST_FIELDS,
	type ShoppingList,
	ShoppingListSchema,
} from "./s-ostoslista.ts";

export type GqlCall = <T>(
	query: string,
	variables: Record<string, unknown>,
	schema: z.ZodType<T>,
) => Promise<T>;

export type Product = z.infer<typeof ProductSchema>;

export type ItemInput = {
	name?: string;
	ean?: string;
	quantity?: number;
	quantityUnit?: string;
};

export type ProductResolvedItemInput = {
	ean: string;
	sokId: string;
	name: string;
	quantity: number;
	quantityUnit: string;
	isReplaceable: boolean;
};

export type ResolvedItems = {
	items: { name: string }[];
	productResolvedItems: ProductResolvedItemInput[];
	unresolvedEans: string[];
};

export type ItemUpdate = {
	itemId: string;
	name?: string;
	collected?: boolean;
	quantity?: number;
	quantityUnit?: string;
};

export type ShoppingListMode = "PLAN" | "SCAN";

export type AddItemsResult = {
	list: ShoppingList;
	added: string[];
	alreadyOnList: AlreadyOnList[];
	similarOnList: SimilarOnList[];
};

// The app only adds an EAN as a product once it has the store's product
// record (sokId, name, unit). An EAN the store doesn't know is reported back
// instead of silently becoming free text, so the agent can decide.
export function resolveItems(inputs: ItemInput[], products: Product[]): ResolvedItems {
	const byEan = new Map(products.map((p) => [p.ean, p]));
	const result: ResolvedItems = { items: [], productResolvedItems: [], unresolvedEans: [] };
	for (const input of inputs) {
		if (input.ean) {
			const product = byEan.get(input.ean);
			if (!product?.id) {
				result.unresolvedEans.push(input.ean);
				continue;
			}
			result.productResolvedItems.push({
				ean: input.ean,
				// The app's ProductResolvedShoppingListItem.sokId is the product's id.
				sokId: product.id,
				name: product.name ?? input.name ?? input.ean,
				quantity: input.quantity ?? 1,
				quantityUnit: input.quantityUnit ?? product.priceUnit ?? "KPL",
				// Only matters for picked web orders, which this tool never places.
				isReplaceable: true,
			});
		} else if (input.name) {
			// Free-text items have no quantity field in the API; refusing beats
			// silently adding "maito" when the agent asked for two.
			if (input.quantity !== undefined || input.quantityUnit !== undefined) {
				throw new Error(
					`Free-text item "${input.name}" cannot carry a quantity; put it in the name or add it by ean.`,
				);
			}
			result.items.push({ name: input.name });
		} else {
			throw new Error("Each item needs a name or an ean.");
		}
	}
	return result;
}

export type AlreadyOnList = {
	input: ItemInput;
	itemId: string;
	name: string;
	quantity: number | null;
};

export type SimilarOnList = { input: string; itemId: string; name: string };

export type OnListCheck = {
	toAdd: ItemInput[];
	alreadyOnList: AlreadyOnList[];
	similarOnList: SimilarOnList[];
};

const normalizeName = (name: string) => name.trim().toLocaleLowerCase("fi");

// The API happily inserts a second "maito" row, which is rarely what an agent
// asked for. Only open (uncollected) items count: a collected one means it is
// being bought again. Anything vaguer than the same EAN or the same name is
// added and only hinted at, since "maito" next to "rasvaton maito 1l" may be
// deliberate.
export function findOnList(
	list: ShoppingList,
	inputs: ItemInput[],
	allowDuplicates = false,
): OnListCheck {
	const open = list.items.filter((i) => !i.collected);
	const result: OnListCheck = { toAdd: [], alreadyOnList: [], similarOnList: [] };
	for (const input of inputs) {
		const name = input.name === undefined ? undefined : normalizeName(input.name);
		const same = open.find((item) =>
			input.ean
				? item.ean === input.ean || (item.products ?? []).some((p) => p.ean === input.ean)
				: name !== undefined && normalizeName(item.name) === name,
		);
		if (same && !allowDuplicates) {
			result.alreadyOnList.push({
				input,
				itemId: same.id,
				name: same.name,
				quantity: same.quantity ?? same.products?.[0]?.quantity ?? null,
			});
			continue;
		}
		result.toAdd.push(input);
		if (input.name === undefined || name === undefined || name === "") continue;
		for (const item of open) {
			const other = normalizeName(item.name);
			if (other.includes(name) || name.includes(other)) {
				result.similarOnList.push({ input: input.name, itemId: item.id, name: item.name });
			}
		}
	}
	return result;
}

// batchUpdateShoppingListItem takes ids[i] ↔ items[i].
export function buildItemUpdates(updates: ItemUpdate[]): {
	ids: string[];
	items: Omit<ItemUpdate, "itemId">[];
} {
	const seen = new Set<string>();
	const ids: string[] = [];
	const items: Omit<ItemUpdate, "itemId">[] = [];
	for (const { itemId, ...patch } of updates) {
		if (seen.has(itemId)) throw new Error(`Item ${itemId} is listed more than once.`);
		seen.add(itemId);
		const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
		if (Object.keys(fields).length === 0)
			throw new Error(`Update for item ${itemId} changes nothing.`);
		ids.push(itemId);
		items.push(fields);
	}
	return { ids, items };
}

// The app shares "Sinulle on jaettu S-ostoslista: https://s-ostoslista.fi/liity/<id>"
// (domain from its prod config); accept that message, the URL or the bare id.
const SHARE_URL_BASE = "https://s-ostoslista.fi/liity/";

export function parseShareLinkId(input: string): string | null {
	const fromUrl = /s-ostoslista\.fi\/liity\/([\w-]+)/.exec(input)?.[1];
	if (fromUrl) return fromUrl;
	const bare = input.trim();
	return /^[\w-]+$/.test(bare) ? bare : null;
}

export type SharePermission = "READ" | "WRITE" | "SHARE";

// What the app itself shares with. Narrower links (e.g. READ only) work, but the
// app still shows edit and delete controls that then fail with a generic error
// (tried live 2026-10-31), so the MCP tool does not offer them.
export const APP_SHARE_PERMISSIONS: readonly SharePermission[] = ["READ", "WRITE", "SHARE"];

function assertItemsOnList(list: ShoppingList, itemIds: string[]): void {
	const known = new Set(list.items.map((i) => i.id));
	const unknown = itemIds.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		throw new Error(`Items not on list ${list.id}: ${unknown.join(", ")}. Nothing was changed.`);
	}
}

const ShoppingListDataSchema = z.object({ shoppingList: ShoppingListSchema });
const CreateDataSchema = z.object({ createShoppingList: ShoppingListSchema.nullable() });
const InsertDataSchema = z.object({ batchInsertShoppingListItem: ShoppingListSchema });
const UpdateDataSchema = z.object({ batchUpdateShoppingListItem: ShoppingListSchema });
const DeleteItemsDataSchema = z.object({ batchDeleteShoppingListItem: ShoppingListSchema });
const DeleteListDataSchema = z.object({ deleteShoppingList: z.object({ id: z.string() }) });
const ShareDataSchema = z.object({ generateShoppingListShareLink: z.object({ id: z.string() }) });
const ClaimDataSchema = z.object({ claimSharedShoppingList: ShoppingListSchema });
const SearchDataSchema = z.object({
	productSearch: z.object({ items: z.array(ProductSchema), maybeHasMore: z.boolean() }),
});

const SHOPPING_LIST_QUERY = `
	query GetShoppingListById($id: ID!) {
		shoppingList(id: $id) { ${SHOPPING_LIST_FIELDS} }
	}
`;

const CREATE_MUTATION = `
	mutation CreateShoppingList(
		$name: String!
		$storeId: String
		$mode: ShoppingListMode
		$items: [CreateShoppingListItemInput!]
		$productResolvedItems: [CreateProductResolvedShoppingListItemInput!]
	) {
		createShoppingList(
			name: $name
			storeId: $storeId
			mode: $mode
			items: $items
			productResolvedItems: $productResolvedItems
		) { ${SHOPPING_LIST_FIELDS} }
	}
`;

const INSERT_MUTATION = `
	mutation BatchInsertShoppingListItem(
		$shoppingListId: ID!
		$items: [CreateShoppingListItemInput!]
		$productResolvedItems: [CreateProductResolvedShoppingListItemInput!]
	) {
		batchInsertShoppingListItem(
			shoppingListId: $shoppingListId
			items: $items
			productResolvedItems: $productResolvedItems
		) { ${SHOPPING_LIST_FIELDS} }
	}
`;

const UPDATE_MUTATION = `
	mutation BatchUpdateShoppingListItem(
		$shoppingListId: ID!
		$ids: [ID!]!
		$items: [UpdateShoppingListItemInput!]!
	) {
		batchUpdateShoppingListItem(shoppingListId: $shoppingListId, ids: $ids, items: $items) {
			${SHOPPING_LIST_FIELDS}
		}
	}
`;

const DELETE_ITEMS_MUTATION = `
	mutation BatchDeleteShoppingListItem($shoppingListId: ID!, $ids: [ID!]!) {
		batchDeleteShoppingListItem(shoppingListId: $shoppingListId, ids: $ids) {
			${SHOPPING_LIST_FIELDS}
		}
	}
`;

const DELETE_LIST_MUTATION = `
	mutation DeleteShoppingList($id: ID!) {
		deleteShoppingList(id: $id) { id }
	}
`;

const SHARE_MUTATION = `
	mutation GenerateShoppingListShareLink(
		$id: ID!
		$permissions: [Permission!]!
		$validForHours: Int
	) {
		generateShoppingListShareLink(
			id: $id
			permissions: $permissions
			validForHours: $validForHours
		) { id }
	}
`;

const CLAIM_MUTATION = `
	mutation ClaimSharedShoppingList($linkId: ID!) {
		claimSharedShoppingList(linkId: $linkId) { ${SHOPPING_LIST_FIELDS} }
	}
`;

const EAN_SEARCH_PAGE_SIZE = 20;

const SEARCH_QUERY = `
	query ProductSearchInStore($storeId: ID, $query: String, $pageSize: Int) {
		productSearch(storeId: $storeId, query: $query, pageSize: $pageSize) {
			maybeHasMore
			items { ${PRODUCT_FIELDS} measurement { netWeight netWeightUnit } }
		}
	}
`;

export function createShoppingListApi(call: GqlCall) {
	async function fetchShoppingList(id: string): Promise<ShoppingList> {
		const data = await call(SHOPPING_LIST_QUERY, { id }, ShoppingListDataSchema);
		return data.shoppingList;
	}

	// products/productByEan answer "Not Authorized" for this client (live
	// 2026-10-30) while productSearch works, and a search by the exact product
	// name returns it first. So each EAN item is matched in a store search for
	// its name; the EAN check keeps a near-miss from being added.
	async function resolveInStore(storeId: string, inputs: ItemInput[]) {
		const missingName = inputs.find((i) => i.ean && !i.name);
		if (missingName) {
			throw new Error(
				`Item with ean ${missingName.ean} needs the product name too (from ` +
					"search_shopping_list_products): the store is searched by name. Nothing was written.",
			);
		}
		const searches = [...new Set(inputs.flatMap((i) => (i.ean && i.name ? [i.name] : [])))];
		const products: Product[] = [];
		for (const query of searches) {
			const data = await call(
				SEARCH_QUERY,
				{ storeId, query, pageSize: EAN_SEARCH_PAGE_SIZE },
				SearchDataSchema,
			);
			products.push(...data.productSearch.items);
		}
		const resolved = resolveItems(inputs, products);
		if (resolved.unresolvedEans.length > 0) {
			throw new Error(
				`EANs not found in store ${storeId}: ${resolved.unresolvedEans.join(", ")}. ` +
					"Nothing was written; add them by name instead or pick another product.",
			);
		}
		return resolved;
	}

	async function createShoppingList(args: {
		name: string;
		storeId: string;
		mode: ShoppingListMode;
		items: ItemInput[];
	}): Promise<ShoppingList> {
		const { items, productResolvedItems } = await resolveInStore(args.storeId, args.items);
		const data = await call(
			CREATE_MUTATION,
			{ name: args.name, storeId: args.storeId, mode: args.mode, items, productResolvedItems },
			CreateDataSchema,
		);
		if (!data.createShoppingList) throw new Error("S-ostoslista created no list.");
		logger.info(
			{
				listId: data.createShoppingList.id,
				storeId: args.storeId,
				items: items.length,
				products: productResolvedItems.length,
			},
			"S-ostoslista list created",
		);
		return data.createShoppingList;
	}

	async function addItems(
		listId: string,
		inputs: ItemInput[],
		options: { allowDuplicates?: boolean } = {},
	): Promise<AddItemsResult> {
		const list = await fetchShoppingList(listId);
		const { toAdd, alreadyOnList, similarOnList } = findOnList(
			list,
			inputs,
			options.allowDuplicates,
		);
		if (alreadyOnList.length > 0) {
			logger.info(
				{ listId, skipped: alreadyOnList.map((d) => d.itemId) },
				"S-ostoslista items already on the list, not added again",
			);
		}
		if (toAdd.length === 0) return { list, added: [], alreadyOnList, similarOnList };
		let resolved: ResolvedItems;
		if (!toAdd.some((i) => i.ean)) {
			resolved = resolveItems(toAdd, []);
		} else if (list.storeId) {
			resolved = await resolveInStore(list.storeId, toAdd);
		} else {
			throw new Error(
				`List ${listId} has no store, so EANs cannot be resolved; add items by name.`,
			);
		}
		const { items, productResolvedItems } = resolved;
		const data = await call(
			INSERT_MUTATION,
			{ shoppingListId: listId, items, productResolvedItems },
			InsertDataSchema,
		);
		logger.info(
			{ listId, items: items.length, products: productResolvedItems.length },
			"S-ostoslista items added",
		);
		return {
			list: data.batchInsertShoppingListItem,
			added: [...productResolvedItems.map((p) => p.name), ...items.map((i) => i.name)],
			alreadyOnList,
			similarOnList,
		};
	}

	async function updateItems(listId: string, updates: ItemUpdate[]): Promise<ShoppingList> {
		const { ids, items } = buildItemUpdates(updates);
		assertItemsOnList(await fetchShoppingList(listId), ids);
		const data = await call(
			UPDATE_MUTATION,
			{ shoppingListId: listId, ids, items },
			UpdateDataSchema,
		);
		logger.info({ listId, items: ids.length }, "S-ostoslista items updated");
		return data.batchUpdateShoppingListItem;
	}

	async function removeItems(listId: string, itemIds: string[]): Promise<ShoppingList> {
		const ids = [...new Set(itemIds)];
		assertItemsOnList(await fetchShoppingList(listId), ids);
		const data = await call(
			DELETE_ITEMS_MUTATION,
			{ shoppingListId: listId, ids },
			DeleteItemsDataSchema,
		);
		logger.info({ listId, items: ids.length }, "S-ostoslista items removed");
		return data.batchDeleteShoppingListItem;
	}

	async function deleteShoppingList(listId: string): Promise<string> {
		const data = await call(DELETE_LIST_MUTATION, { id: listId }, DeleteListDataSchema);
		logger.info({ listId }, "S-ostoslista list deleted");
		return data.deleteShoppingList.id;
	}

	async function searchProducts(
		storeId: string,
		query: string,
		pageSize: number,
	): Promise<{ products: Product[]; maybeHasMore: boolean }> {
		const data = await call(SEARCH_QUERY, { storeId, query, pageSize }, SearchDataSchema);
		return { products: data.productSearch.items, maybeHasMore: data.productSearch.maybeHasMore };
	}

	async function shareShoppingList(
		listId: string,
		permissions: SharePermission[] = [...APP_SHARE_PERMISSIONS],
		validForHours = 24,
	): Promise<string> {
		const data = await call(
			SHARE_MUTATION,
			{ id: listId, permissions, validForHours },
			ShareDataSchema,
		);
		logger.info({ listId, permissions, validForHours }, "S-ostoslista share link created");
		return `${SHARE_URL_BASE}${data.generateShoppingListShareLink.id}`;
	}

	async function claimSharedShoppingList(link: string): Promise<ShoppingList> {
		const linkId = parseShareLinkId(link);
		if (!linkId) throw new Error(`Not an S-ostoslista share link: ${link}`);
		const data = await call(CLAIM_MUTATION, { linkId }, ClaimDataSchema);
		logger.info(
			{
				listId: data.claimSharedShoppingList.id,
				permissions: data.claimSharedShoppingList.permissions,
			},
			"S-ostoslista shared list claimed",
		);
		return data.claimSharedShoppingList;
	}

	return {
		fetchShoppingList,
		createShoppingList,
		addItems,
		updateItems,
		removeItems,
		deleteShoppingList,
		searchProducts,
		shareShoppingList,
		claimSharedShoppingList,
	};
}

export const shoppingListApi = createShoppingListApi(gql);
