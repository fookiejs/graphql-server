import { z } from "zod";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { Done, Model, Types, app } from "@fookiejs/core";
import { graphqlServer } from "../src/server.ts";

const databaseUrl = process.env.FOOKIE_TEST_DATABASE ?? "";

const passthrough = {
  async create() {
    return Done;
  },
  async list() {
    return Done;
  },
  async update() {
    return Done;
  },
  async delete() {
    return Done;
  },
};

const shop = Model({ name: "E2eShop", fields: { label: z.string() }, flow: passthrough });

const item = Model({
  name: "E2eItem",
  fields: { name: z.string(), price: z.number().int(), shop: Types.relation({ name: "E2eShop" }) },
  flow: passthrough,
});

describe("end to end graphql", { skip: databaseUrl.length === 0 }, () => {
  let pool: pg.Pool;

  before(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  });

  after(async () => {
    await pool.end();
  });

  function boot() {
    return app({
      listen: "0",
      database: databaseUrl,
      models: [shop, item],
      externals: [] as const,
      onExternalEvent: async () => {},
      pool: [
        {
          query: (sql: string, params?: unknown[]) => pool.query(sql, params),
          connect: () => pool.connect(),
          end: [],
        },
      ],
    });
  }

  it("answers a nested query end to end", async () => {
    const fookie = boot();
    const stamp = `${Date.now()}`;
    const made = await fookie.create(shop, { label: `shop-${stamp}` });
    if (made.signal !== "done") {
      throw new Error("shop must be created");
    }
    for (let i = 0; i < 3; i += 1) {
      const created = await fookie.create(item, {
        name: `item-${i}-${stamp}`,
        price: i * 10,
        shop: made.id,
      });
      if (created.signal !== "done") {
        throw new Error("item must be created");
      }
    }

    const server = graphqlServer(fookie);
    const result = await server.execute(
      `query Shops($label: String) {
         e2eShops(filter: { label: { eq: $label } }) {
           id
           label
           e2eItems { name price }
         }
       }`,
      { label: `shop-${stamp}` },
    );

    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const shops = (result.data?.e2eShops ?? []) as readonly Record<string, unknown>[];
    assert.equal(shops.length, 1);
    for (const row of shops) {
      assert.equal(row.label, `shop-${stamp}`);
      const items = (row.e2eItems ?? []) as readonly Record<string, unknown>[];
      assert.equal(items.length, 3, "the reverse relation resolved from the prefetched store");
      for (const line of items) {
        assert.match(String(line.name), new RegExp(`item-\\d-${stamp}`));
      }
    }

    await server.stop();
    await fookie.stop();
  });

  it("walks back up a forward relation", async () => {
    const fookie = boot();
    const stamp = `${Date.now()}b`;
    const made = await fookie.create(shop, { label: `up-${stamp}` });
    if (made.signal !== "done") {
      throw new Error("shop must be created");
    }
    const created = await fookie.create(item, {
      name: `up-item-${stamp}`,
      price: 5,
      shop: made.id,
    });
    if (created.signal !== "done") {
      throw new Error("item must be created");
    }

    const server = graphqlServer(fookie);
    const result = await server.execute(
      `{ e2eItems(filter: { name: { eq: "up-item-${stamp}" } }) { name shop { label } } }`,
    );
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const items = (result.data?.e2eItems ?? []) as readonly Record<string, unknown>[];
    assert.equal(items.length, 1);
    for (const row of items) {
      const parent = row.shop as Record<string, unknown>;
      assert.equal(parent.label, `up-${stamp}`);
    }

    await server.stop();
    await fookie.stop();
  });

  it("rejects a query the schema does not allow", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie);
    const result = await server.execute("{ e2eShops { notAField } }");
    assert.ok(result.errors !== undefined);
    assert.match(String(result.errors?.[0]?.message), /notAField/);
    await server.stop();
    await fookie.stop();
  });

  it("serves the same query over http", async () => {
    const fookie = boot();
    const stamp = `${Date.now()}c`;
    const made = await fookie.create(shop, { label: `http-${stamp}` });
    if (made.signal !== "done") {
      throw new Error("shop must be created");
    }

    const server = graphqlServer(fookie, {
      port: ["24771"],
      limits: [],
      snapshot: true,
      budget: [],
      subscriptions: [],
    });
    const response = await fetch("http://127.0.0.1:24771", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ e2eShops(filter: { label: { eq: "http-${stamp}" } }) { label } }`,
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data?: Record<string, unknown> };
    const shops = (body.data?.e2eShops ?? []) as readonly Record<string, unknown>[];
    assert.equal(shops.length, 1);
    for (const row of shops) {
      assert.equal(row.label, `http-${stamp}`);
    }

    await server.stop();
    await fookie.stop();
  });
});
