import { z } from "zod";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { Done, Model, Types, app, emptyListPage } from "@fookiejs/core";
import type { FilterInput } from "@fookiejs/core";
import { ModelGraph } from "../src/registry.ts";
import { prefetch } from "../src/plan/prefetch.ts";
import type { Selection } from "../src/plan/prefetch.ts";

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

const owner = Model({ name: "GqOwner", fields: { name: z.string() }, flow: passthrough });

const house = Model({
  name: "GqHouse",
  fields: { label: z.string(), owner: Types.relation({ name: "GqOwner" }) },
  flow: passthrough,
});

const writer = Model({ name: "GqWriter", fields: { name: z.string() }, flow: passthrough });

const title = Model({
  name: "GqTitle",
  fields: {
    name: z.string(),
    writer: Types.relation({ name: "GqWriter" }),
    house: Types.relation({ name: "GqHouse" }),
  },
  flow: passthrough,
});

const graph = ModelGraph.create([owner, house, writer, title]);

const deep: readonly Selection[] = [
  {
    field: "gqTitles",
    children: [{ field: "house", children: [{ field: "owner", children: [] }] }],
  },
];

describe("batching against real postgres", { skip: databaseUrl.length === 0 }, () => {
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
      models: [owner, house, writer, title],
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

  it("reads a three-level graph with one select per level", async () => {
    const fookie = boot();
    const stamp = Date.now();

    const ownerA = await fookie.create(owner, { name: `own-a-${stamp}` });
    const ownerB = await fookie.create(owner, { name: `own-b-${stamp}` });
    assert.equal(ownerA.signal, "done");
    assert.equal(ownerB.signal, "done");
    if (ownerA.signal !== "done" || ownerB.signal !== "done") {
      throw new Error("owners must be created");
    }

    const houseA = await fookie.create(house, { label: `h-a-${stamp}`, owner: ownerA.id });
    const houseB = await fookie.create(house, { label: `h-b-${stamp}`, owner: ownerB.id });
    if (houseA.signal !== "done" || houseB.signal !== "done") {
      throw new Error("houses must be created");
    }

    const writers: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const made = await fookie.create(writer, { name: `w-${i}-${stamp}` });
      if (made.signal !== "done") {
        throw new Error("writer must be created");
      }
      writers.push(made.id);
    }
    for (let i = 0; i < writers.length; i += 1) {
      const houseId = i % 2 === 0 ? houseA.id : houseB.id;
      const made = await fookie.create(title, {
        name: `t-${i}-${stamp}`,
        writer: writers[i] ?? "",
        house: houseId,
      });
      if (made.signal !== "done") {
        throw new Error("title must be created");
      }
    }

    const seen: string[] = [];
    const counting = {
      list: async (
        model: Parameters<typeof fookie.list>[0],
        filter: FilterInput,
        page = emptyListPage(),
      ) => {
        seen.push(model.name);
        return await fookie.list(model, filter, page);
      },
    };

    const result = await prefetch(counting, graph, "GqWriter", {}, emptyListPage(), deep);

    assert.deepEqual(
      seen,
      ["GqWriter", "GqTitle", "GqHouse", "GqOwner"],
      "six writers and six titles still cost one query per level",
    );
    assert.ok(result.roots.length >= 6);

    const firstWriter = writers[0] ?? "";
    const titles = result.store.linkedRows("GqWriter", firstWriter, "gqTitles", "GqTitle");
    assert.equal(titles.length, 1, "each writer owns exactly one title");
    for (const row of titles) {
      assert.equal(row.writer, firstWriter, "the child really belongs to this parent");
    }

    await fookie.stop();
  });

  it("holds one snapshot across every level of the traversal", async () => {
    const fookie = boot();
    const stamp = Date.now();
    const made = await fookie.create(owner, { name: `snap-${stamp}` });
    if (made.signal !== "done") {
      throw new Error("owner must be created");
    }

    const seen = await fookie.withReadSnapshot(async (scope) => {
      const before = await prefetch(
        scope,
        graph,
        "GqOwner",
        { id: { eq: made.id } },
        emptyListPage(),
        [],
      );

      const outside = new pg.Pool({ connectionString: databaseUrl });
      await outside.query("UPDATE public.gq_owner SET name = $1 WHERE id = $2", [
        `changed-${stamp}`,
        made.id,
      ]);
      await outside.end();

      const after = await prefetch(
        scope,
        graph,
        "GqOwner",
        { id: { eq: made.id } },
        emptyListPage(),
        [],
      );
      return { before: before.roots, after: after.roots };
    });

    for (const row of seen.after) {
      assert.equal(row.name, `snap-${stamp}`, "a mid-query commit stays invisible to the snapshot");
    }

    const settled = await pool.query("SELECT name FROM public.gq_owner WHERE id = $1", [made.id]);
    for (const row of settled.rows) {
      assert.equal(String(row.name), `changed-${stamp}`, "the outside write really did commit");
    }

    await fookie.stop();
  });
});
