import { describe, expect, test } from "bun:test";
import type * as z from "zod/v4";
import {
	buildItemUpdates,
	createShoppingListApi,
	type GqlCall,
	parseShareLinkId,
	resolveItems,
} from "./s-ostoslista-lists.ts";

// Shapes follow the GraphQL schema shipped inside the S-ostoslista APK
// (data-capture/s-ostoslista/schema.graphql); values are synthetic.

const milk = {
	id: "2000503600002",
	name: "Valio rasvaton maito 1l",
	ean: "6408430000017",
	priceUnit: "KPL",
	pricing: { currentPrice: 1.19 },
	location: { aisle: "12" },
};

function list(items: unknown[] = []) {
	return {
		id: "l1",
		name: "Viikko",
		mode: "PLAN",
		storeId: "513971200",
		shared: false,
		permissions: ["READ", "WRITE", "SHARE"],
		modifiedAt: "2026-10-30T10:00:00.000Z",
		store: { id: "513971200", name: "Prisma Testi" },
		items,
	};
}

const freeTextItem = { __typename: "ShoppingListItem", id: "i1", name: "maito", collected: false };

type Call = { op: string; variables: Record<string, unknown> };

// Answers by operation name and still runs the caller's schema, so the tests
// also cover parsing of each response shape.
function fakeGql(responses: Record<string, unknown>): { call: GqlCall; calls: Call[] } {
	const calls: Call[] = [];
	const call: GqlCall = async <T>(
		query: string,
		variables: Record<string, unknown>,
		schema: z.ZodType<T>,
	): Promise<T> => {
		const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
		calls.push({ op, variables });
		if (!(op in responses)) throw new Error(`unexpected operation ${op}`);
		return schema.parse(responses[op]);
	};
	return { call, calls };
}

describe("resolveItems", () => {
	test("free-text items keep only their name", () => {
		expect(resolveItems([{ name: "maito" }], [])).toEqual({
			items: [{ name: "maito" }],
			productResolvedItems: [],
			unresolvedEans: [],
		});
	});

	test("an EAN found in the store becomes a product-resolved item", () => {
		const result = resolveItems([{ ean: milk.ean, quantity: 2 }], [milk]);
		expect(result.items).toEqual([]);
		expect(result.productResolvedItems).toEqual([
			{
				ean: milk.ean,
				sokId: milk.id,
				name: milk.name,
				quantity: 2,
				quantityUnit: "KPL",
				isReplaceable: true,
			},
		]);
	});

	test("the store's product name wins over the search name", () => {
		const [item] = resolveItems(
			[{ ean: milk.ean, name: "rasvaton maito" }],
			[milk],
		).productResolvedItems;
		expect(item?.name).toBe(milk.name);
	});

	test("defaults quantity to 1 and the unit to the product's price unit", () => {
		const [item] = resolveItems([{ ean: milk.ean }], [milk]).productResolvedItems;
		expect(item?.quantity).toBe(1);
		expect(item?.quantityUnit).toBe("KPL");
		const [kg] = resolveItems(
			[{ ean: milk.ean, quantity: 0.5, quantityUnit: "KG" }],
			[milk],
		).productResolvedItems;
		expect(kg?.quantityUnit).toBe("KG");
	});

	test("an EAN missing from the store is reported, not added as text", () => {
		const result = resolveItems([{ ean: "6400000000000" }, { name: "leipä" }], [milk]);
		expect(result.unresolvedEans).toEqual(["6400000000000"]);
		expect(result.items).toEqual([{ name: "leipä" }]);
		expect(result.productResolvedItems).toEqual([]);
	});

	test("a product without an id cannot be resolved", () => {
		const result = resolveItems([{ ean: milk.ean }], [{ ...milk, id: null }]);
		expect(result.unresolvedEans).toEqual([milk.ean]);
	});

	test("rejects an item with neither name nor EAN", () => {
		expect(() => resolveItems([{ quantity: 2 }], [])).toThrow(/name or an ean/);
	});

	test("rejects a quantity on a free-text item instead of dropping it", () => {
		expect(() => resolveItems([{ name: "maito", quantity: 2 }], [])).toThrow(/maito/);
		expect(() => resolveItems([{ name: "maito", quantityUnit: "KG" }], [])).toThrow(/maito/);
	});
});

describe("parseShareLinkId", () => {
	test("reads the id from the app's share message, URL or the bare id", () => {
		expect(parseShareLinkId("https://s-ostoslista.fi/liity/abc-123")).toBe("abc-123");
		expect(
			parseShareLinkId("Sinulle on jaettu S-ostoslista: https://s-ostoslista.fi/liity/abc-123"),
		).toBe("abc-123");
		expect(parseShareLinkId(" abc-123 ")).toBe("abc-123");
	});

	test("returns null for anything else", () => {
		expect(parseShareLinkId("https://example.com/x")).toBeNull();
		expect(parseShareLinkId("two words")).toBeNull();
		expect(parseShareLinkId("")).toBeNull();
	});
});

describe("buildItemUpdates", () => {
	test("splits updates into the parallel ids/items arrays the mutation takes", () => {
		expect(
			buildItemUpdates([
				{ itemId: "i1", collected: true },
				{ itemId: "i2", name: "kevytmaito", quantity: 3 },
			]),
		).toEqual({
			ids: ["i1", "i2"],
			items: [{ collected: true }, { name: "kevytmaito", quantity: 3 }],
		});
	});

	test("rejects an update that changes nothing", () => {
		expect(() => buildItemUpdates([{ itemId: "i1" }])).toThrow(/i1/);
	});

	test("rejects the same item twice", () => {
		expect(() =>
			buildItemUpdates([
				{ itemId: "i1", collected: true },
				{ itemId: "i1", collected: false },
			]),
		).toThrow(/i1/);
	});
});

describe("shopping list API", () => {
	test("fetchShoppingList asks for one list by id", async () => {
		const { call, calls } = fakeGql({
			GetShoppingListById: { shoppingList: list([freeTextItem]) },
		});
		const result = await createShoppingListApi(call).fetchShoppingList("l1");
		expect(result.items).toHaveLength(1);
		expect(calls).toEqual([{ op: "GetShoppingListById", variables: { id: "l1" } }]);
	});

	test("createShoppingList with only free text skips the product lookup", async () => {
		const { call, calls } = fakeGql({ CreateShoppingList: { createShoppingList: list() } });
		await createShoppingListApi(call).createShoppingList({
			name: "Viikko",
			storeId: "513971200",
			mode: "PLAN",
			items: [{ name: "maito" }],
		});
		expect(calls).toEqual([
			{
				op: "CreateShoppingList",
				variables: {
					name: "Viikko",
					storeId: "513971200",
					mode: "PLAN",
					items: [{ name: "maito" }],
					productResolvedItems: [],
				},
			},
		]);
	});

	// products/productByEan answer "Not Authorized" for this client (live
	// 2026-10-30), so EANs are matched in a store search by the product name.
	test("createShoppingList finds EAN items by searching their name in the store", async () => {
		const { call, calls } = fakeGql({
			ProductSearchInStore: { productSearch: { items: [milk], maybeHasMore: false } },
			CreateShoppingList: { createShoppingList: list() },
		});
		await createShoppingListApi(call).createShoppingList({
			name: "Viikko",
			storeId: "513971200",
			mode: "PLAN",
			items: [{ ean: milk.ean, name: milk.name }],
		});
		expect(calls[0]).toEqual({
			op: "ProductSearchInStore",
			variables: { storeId: "513971200", query: milk.name, pageSize: 20 },
		});
		expect(calls[1]?.variables.productResolvedItems).toEqual([
			expect.objectContaining({ ean: milk.ean, sokId: milk.id, name: milk.name }),
		]);
	});

	test("an EAN the name search does not return creates nothing", async () => {
		const other = { ...milk, ean: "6400000000000" };
		const { call, calls } = fakeGql({
			ProductSearchInStore: { productSearch: { items: [other], maybeHasMore: true } },
		});
		await expect(
			createShoppingListApi(call).createShoppingList({
				name: "Viikko",
				storeId: "513971200",
				mode: "PLAN",
				items: [{ ean: milk.ean, name: milk.name }],
			}),
		).rejects.toThrow(milk.ean);
		expect(calls.map((c) => c.op)).toEqual(["ProductSearchInStore"]);
	});

	test("an EAN item without a name is refused before any call", async () => {
		const { call, calls } = fakeGql({});
		await expect(
			createShoppingListApi(call).createShoppingList({
				name: "Viikko",
				storeId: "513971200",
				mode: "PLAN",
				items: [{ ean: milk.ean }],
			}),
		).rejects.toThrow(/name/);
		expect(calls).toEqual([]);
	});

	test("createShoppingList returning null is an error", async () => {
		const { call } = fakeGql({ CreateShoppingList: { createShoppingList: null } });
		await expect(
			createShoppingListApi(call).createShoppingList({
				name: "Viikko",
				storeId: "513971200",
				mode: "PLAN",
				items: [],
			}),
		).rejects.toThrow(/no list/);
	});

	test("addItems looks up EANs in the store of the list", async () => {
		const { call, calls } = fakeGql({
			GetShoppingListById: { shoppingList: list() },
			ProductSearchInStore: { productSearch: { items: [milk], maybeHasMore: false } },
			BatchInsertShoppingListItem: { batchInsertShoppingListItem: list([freeTextItem]) },
		});
		await createShoppingListApi(call).addItems("l1", [
			{ ean: milk.ean, name: milk.name },
			{ name: "maito" },
		]);
		expect(calls.map((c) => c.op)).toEqual([
			"GetShoppingListById",
			"ProductSearchInStore",
			"BatchInsertShoppingListItem",
		]);
		expect(calls[1]?.variables.storeId).toBe("513971200");
		expect(calls[2]?.variables).toEqual({
			shoppingListId: "l1",
			items: [{ name: "maito" }],
			productResolvedItems: [expect.objectContaining({ ean: milk.ean, sokId: milk.id })],
		});
	});

	test("addItems with EANs on a list without a store fails before writing", async () => {
		const { call, calls } = fakeGql({
			GetShoppingListById: { shoppingList: { ...list(), storeId: null, store: null } },
		});
		await expect(createShoppingListApi(call).addItems("l1", [{ ean: milk.ean }])).rejects.toThrow(
			/no store/,
		);
		expect(calls.map((c) => c.op)).toEqual(["GetShoppingListById"]);
	});

	test("updateItems refuses ids that are not on the list", async () => {
		const { call, calls } = fakeGql({
			GetShoppingListById: { shoppingList: list([freeTextItem]) },
		});
		await expect(
			createShoppingListApi(call).updateItems("l1", [{ itemId: "nope", collected: true }]),
		).rejects.toThrow(/nope/);
		expect(calls.map((c) => c.op)).toEqual(["GetShoppingListById"]);
	});

	test("updateItems sends the parallel arrays", async () => {
		const { call, calls } = fakeGql({
			GetShoppingListById: { shoppingList: list([freeTextItem]) },
			BatchUpdateShoppingListItem: { batchUpdateShoppingListItem: list([freeTextItem]) },
		});
		await createShoppingListApi(call).updateItems("l1", [{ itemId: "i1", collected: true }]);
		expect(calls[1]).toEqual({
			op: "BatchUpdateShoppingListItem",
			variables: { shoppingListId: "l1", ids: ["i1"], items: [{ collected: true }] },
		});
	});

	test("removeItems refuses ids that are not on the list", async () => {
		const { call, calls } = fakeGql({
			GetShoppingListById: { shoppingList: list([freeTextItem]) },
		});
		await expect(createShoppingListApi(call).removeItems("l1", ["i1", "nope"])).rejects.toThrow(
			/nope/,
		);
		expect(calls.map((c) => c.op)).toEqual(["GetShoppingListById"]);
	});

	test("removeItems deletes by id", async () => {
		const { call, calls } = fakeGql({
			GetShoppingListById: { shoppingList: list([freeTextItem]) },
			BatchDeleteShoppingListItem: { batchDeleteShoppingListItem: list() },
		});
		const result = await createShoppingListApi(call).removeItems("l1", ["i1"]);
		expect(result.items).toEqual([]);
		expect(calls[1]).toEqual({
			op: "BatchDeleteShoppingListItem",
			variables: { shoppingListId: "l1", ids: ["i1"] },
		});
	});

	test("deleteShoppingList returns the deleted id", async () => {
		const { call } = fakeGql({ DeleteShoppingList: { deleteShoppingList: { id: "l1" } } });
		expect(await createShoppingListApi(call).deleteShoppingList("l1")).toBe("l1");
	});

	test("shareShoppingList builds the app's join URL", async () => {
		const { call, calls } = fakeGql({
			GenerateShoppingListShareLink: { generateShoppingListShareLink: { id: "link-1" } },
		});
		const url = await createShoppingListApi(call).shareShoppingList("l1", ["READ", "WRITE"], 24);
		expect(url).toBe("https://s-ostoslista.fi/liity/link-1");
		expect(calls[0]?.variables).toEqual({
			id: "l1",
			permissions: ["READ", "WRITE"],
			validForHours: 24,
		});
	});

	test("claimSharedShoppingList accepts the join URL or the bare link id", async () => {
		const { call, calls } = fakeGql({
			ClaimSharedShoppingList: { claimSharedShoppingList: { ...list(), shared: true } },
		});
		const api = createShoppingListApi(call);
		await api.claimSharedShoppingList(
			"Sinulle on jaettu S-ostoslista: https://s-ostoslista.fi/liity/abc-123",
		);
		await api.claimSharedShoppingList("abc-123");
		expect(calls.map((c) => c.variables)).toEqual([{ linkId: "abc-123" }, { linkId: "abc-123" }]);
	});

	test("claimSharedShoppingList rejects a URL that is not a join link", async () => {
		const { call, calls } = fakeGql({});
		await expect(
			createShoppingListApi(call).claimSharedShoppingList("https://example.com/x y"),
		).rejects.toThrow(/link/);
		expect(calls).toEqual([]);
	});

	test("searchProducts searches one store", async () => {
		const { call, calls } = fakeGql({
			ProductSearchInStore: { productSearch: { items: [milk], maybeHasMore: true } },
		});
		const result = await createShoppingListApi(call).searchProducts("513971200", "maito", 10);
		expect(result).toEqual({
			products: [expect.objectContaining({ ean: milk.ean })],
			maybeHasMore: true,
		});
		expect(calls[0]?.variables).toEqual({ storeId: "513971200", query: "maito", pageSize: 10 });
	});
});
