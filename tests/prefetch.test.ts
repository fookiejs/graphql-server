import { z } from "zod";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Done, Model, Types, emptyListPage } from "@fookiejs/core";
import type {
  EntityRecord,
  FilterInput,
  ListPage,
  ModelDef,
  ModelFieldsInput,
} from "@fookiejs/core";
import { ModelGraph } from "../src/registry.ts";
import { chunksOf, distinct, prefetch } from "../src/plan/prefetch.ts";
import type { Selection } from "../src/plan/prefetch.ts";

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

const owner = Model({ name: "Owner", fields: { name: z.string() }, flow: passthrough });

const publisher = Model({
  name: "Publisher",
  fields: { title: z.string(), owner: Types.relation({ name: "Owner" }) },
  flow: passthrough,
});

const author = Model({
  name: "Author",
  fields: { name: z.string() },
  flow: passthrough,
});

const book = Model({
  name: "Book",
  fields: {
    title: z.string(),
    author: Types.relation({ name: "Author" }),
    publisher: Types.relation({ name: "Publisher" }),
  },
  flow: passthrough,
});

const graph = ModelGraph.create([owner, publisher, author, book]);

type Call = { model: string; filter: FilterInput };

class RecordingPort {
  readonly calls: Call[] = [];
  private readonly tables: Map<string, readonly EntityRecord[]>;

  constructor(tables: Map<string, readonly EntityRecord[]>) {
    this.tables = tables;
  }

  async list(model: ModelDef<ModelFieldsInput>, filter: FilterInput, page?: ListPage) {
    this.calls.push({ model: model.name, filter });
    const rows = this.tables.get(model.name) ?? [];
    const matched = rows.filter((row) => matches(row, filter));
    const limited = page?.limit?.[0] === undefined ? matched : matched.slice(0, page.limit[0]);
    return { signal: "done" as const, runId: "run", results: limited };
  }
}

function matches(row: EntityRecord, filter: FilterInput): boolean {
  for (const [key, clause] of Object.entries(filter)) {
    if (clause === undefined) {
      continue;
    }
    const bag = clause as Record<string, unknown>;
    if ("eq" in bag && row[key] !== bag.eq) {
      return false;
    }
    if ("in" in bag) {
      const list = bag.in as readonly unknown[];
      if (list.includes(row[key]) === false) {
        return false;
      }
    }
  }
  return true;
}

function authorRows(count: number): readonly EntityRecord[] {
  const rows: EntityRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ id: `a${i}`, name: `Author ${i}` });
  }
  return rows;
}

function bookRows(authors: number, perAuthor: number): readonly EntityRecord[] {
  const rows: EntityRecord[] = [];
  for (let a = 0; a < authors; a += 1) {
    for (let b = 0; b < perAuthor; b += 1) {
      rows.push({
        id: `b${a}-${b}`,
        title: `Book ${a}-${b}`,
        author: `a${a}`,
        publisher: `p${a % 2}`,
      });
    }
  }
  return rows;
}

function fullTables(authors: number, perAuthor: number): Map<string, readonly EntityRecord[]> {
  return new Map<string, readonly EntityRecord[]>([
    ["Author", authorRows(authors)],
    ["Book", bookRows(authors, perAuthor)],
    [
      "Publisher",
      [
        { id: "p0", title: "P Zero", owner: "o0" },
        { id: "p1", title: "P One", owner: "o1" },
      ],
    ],
    [
      "Owner",
      [
        { id: "o0", name: "Owner Zero" },
        { id: "o1", name: "Owner One" },
      ],
    ],
  ]);
}

const deepSelection: readonly Selection[] = [
  {
    field: "books",
    children: [{ field: "publisher", children: [{ field: "owner", children: [] }] }],
  },
];

describe("prefetch batching", () => {
  it("issues one query per level, not one per row", async () => {
    const port = new RecordingPort(fullTables(20, 5));
    await prefetch(port, graph, "Author", {}, emptyListPage(), deepSelection);

    assert.equal(
      port.calls.length,
      4,
      `expected four levels, got ${port.calls.map((c) => c.model)}`,
    );
    assert.deepEqual(
      port.calls.map((call) => call.model),
      ["Author", "Book", "Publisher", "Owner"],
    );
  });

  it("keeps the query count flat as the row count grows", async () => {
    const small = new RecordingPort(fullTables(5, 2));
    const large = new RecordingPort(fullTables(200, 10));
    await prefetch(small, graph, "Author", {}, emptyListPage(), deepSelection);
    await prefetch(large, graph, "Author", {}, emptyListPage(), deepSelection);
    assert.equal(small.calls.length, large.calls.length, "cost depends on depth, not on rows");
  });

  it("batches children with a single IN over the deduped parent ids", async () => {
    const port = new RecordingPort(fullTables(3, 2));
    await prefetch(port, graph, "Author", {}, emptyListPage(), [{ field: "books", children: [] }]);
    const bookCall = port.calls.filter((call) => call.model === "Book");
    assert.equal(bookCall.length, 1);
    for (const call of bookCall) {
      const clause = call.filter.author as { in: readonly string[] };
      assert.deepEqual(clause.in, ["a0", "a1", "a2"]);
    }
  });

  it("dedupes forward ids so two books sharing a publisher fetch it once", async () => {
    const port = new RecordingPort(fullTables(4, 3));
    await prefetch(port, graph, "Author", {}, emptyListPage(), [
      { field: "books", children: [{ field: "publisher", children: [] }] },
    ]);
    const publisherCall = port.calls.filter((call) => call.model === "Publisher");
    assert.equal(publisherCall.length, 1);
    for (const call of publisherCall) {
      const clause = call.filter.id as { in: readonly string[] };
      assert.deepEqual(clause.in, ["p0", "p1"], "twelve books, two distinct publishers");
    }
  });

  it("issues no query at all when no parent has the relation", async () => {
    const tables = new Map<string, readonly EntityRecord[]>([
      ["Author", authorRows(3)],
      ["Book", []],
      ["Publisher", []],
      ["Owner", []],
    ]);
    const port = new RecordingPort(tables);
    await prefetch(port, graph, "Author", {}, emptyListPage(), [
      { field: "books", children: [{ field: "publisher", children: [] }] },
    ]);
    assert.deepEqual(
      port.calls.map((call) => call.model),
      ["Author", "Book"],
      "an empty child set must not produce a Publisher query with an empty IN",
    );
  });

  it("groups children back to the parent that owns them", async () => {
    const port = new RecordingPort(fullTables(3, 2));
    const result = await prefetch(port, graph, "Author", {}, emptyListPage(), [
      { field: "books", children: [] },
    ]);
    const mine = result.store.linkedRows("Author", "a1", "books", "Book");
    assert.equal(mine.length, 2);
    for (const row of mine) {
      assert.equal(row.author, "a1");
    }
  });

  it("chunks a wide id list", () => {
    const ids = distinct(["a", "b", "c", "d", "e", "a"]);
    assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);
    const chunks = chunksOf(ids, 2);
    assert.deepEqual(chunks, [["a", "b"], ["c", "d"], ["e"]]);
  });

  it("splits a batch that exceeds the chunk size into several queries", async () => {
    const port = new RecordingPort(fullTables(25, 1));
    await prefetch(port, graph, "Author", {}, emptyListPage(), [{ field: "books", children: [] }], {
      maxDepth: 8,
      maxRows: 50_000,
      maxInChunk: 10,
    });
    const bookCalls = port.calls.filter((call) => call.model === "Book");
    assert.equal(bookCalls.length, 3, "25 parents at 10 per chunk is three queries");
  });

  it("does not refetch an entity a previous level already loaded", async () => {
    const port = new RecordingPort(fullTables(3, 2));
    await prefetch(port, graph, "Author", {}, emptyListPage(), [
      {
        field: "books",
        children: [{ field: "publisher", children: [{ field: "owner", children: [] }] }],
      },
      { field: "books", children: [{ field: "publisher", children: [] }] },
    ]);
    const publisherCalls = port.calls.filter((call) => call.model === "Publisher");
    assert.equal(
      publisherCalls.length,
      1,
      "the second branch asks for publishers the first branch already loaded",
    );
  });

  it("refuses a query deeper than the limit", async () => {
    const port = new RecordingPort(fullTables(2, 1));
    await assert.rejects(
      () =>
        prefetch(port, graph, "Author", {}, emptyListPage(), deepSelection, {
          maxDepth: 2,
          maxRows: 50_000,
          maxInChunk: 1_000,
        }),
      /maximum depth/,
    );
  });

  it("refuses a query that would read too many rows", async () => {
    const port = new RecordingPort(fullTables(50, 20));
    await assert.rejects(
      () =>
        prefetch(port, graph, "Author", {}, emptyListPage(), [{ field: "books", children: [] }], {
          maxDepth: 8,
          maxRows: 100,
          maxInChunk: 1_000,
        }),
      /more than 100 rows/,
    );
  });
});
