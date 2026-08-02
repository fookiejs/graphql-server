import { z } from "zod";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { printSchema } from "graphql";
import { Done, Model, Types, filterOpsConfigForGroup } from "@fookiejs/core";
import type { FilterGroup } from "@fookiejs/core";
import { ModelGraph } from "../src/registry.ts";
import { buildSchema } from "../src/graphql-adapter/build.ts";
import { filterOpFieldsFor } from "../src/schema/filters.ts";
import { scalarIsNonNull, scalarTypeNameFor } from "../src/schema/scalars.ts";

function opNamesFor(group: FilterGroup): readonly string[] {
  return filterOpFieldsFor(group).map((field) => field.name);
}

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

const author = Model({
  name: "Author",
  fields: { name: z.string(), rating: z.number() },
  flow: passthrough,
});

const book = Model({
  name: "Book",
  fields: {
    title: z.string(),
    pages: z.number().int(),
    inPrint: z.boolean(),
    author: Types.relation({ name: "Author" }),
  },
  flow: passthrough,
});

function sdl(): string {
  return printSchema(buildSchema(ModelGraph.create([author, book])).schema);
}

describe("schema generation", () => {
  it("gives each model an object type with its scalars", () => {
    const text = sdl();
    assert.match(text, /type Author \{/);
    assert.match(text, /type Book \{/);
    assert.match(text, /title: String/);
    assert.match(text, /pages: Int/);
    assert.match(text, /inPrint: Boolean/);
  });

  it("marks the always-present system columns non-null and domain columns nullable", () => {
    const text = sdl();
    assert.match(text, /\bid: UUID!/);
    assert.match(text, /createdAt: DateTime!/);
    assert.match(text, /isDeleted: Boolean!/);
    assert.match(text, /\btitle: String\b(?!!)/, "a domain column is nullable in postgres");
  });

  it("exposes a forward relation as an object and a reverse relation as a list", () => {
    const text = sdl();
    assert.match(text, /author: Author/);
    assert.match(text, /books\(limit: Int, offset: Int\): \[Book!\]!/);
  });

  it("offers a root field per model, single and plural", () => {
    const text = sdl();
    assert.match(text, /author\(id: UUID!\): Author/);
    assert.match(text, /books\(filter: BookFilter, limit: Int, offset: Int\): \[Book!\]!/);
  });

  it("generates filter inputs whose operators come from core, not from a copy", () => {
    const text = sdl();
    const groups: readonly FilterGroup[] = ["numeric", "string", "uuid", "temporal", "json"];
    for (const group of groups) {
      const config = filterOpsConfigForGroup(group);
      const names = opNamesFor(group);
      assert.ok(names.includes("eq"), `${group} always has eq`);
      assert.equal(names.includes("gt"), config.compare, `${group} compare matches core`);
      assert.equal(names.includes("like"), config.stringPattern, `${group} pattern matches core`);
      assert.equal(names.includes("in"), config.inList, `${group} in matches core`);
      assert.equal(names.includes("contains"), config.contains, `${group} contains matches core`);
      assert.equal(names.includes("near"), config.near, `${group} near matches core`);
    }
    assert.match(text, /input StringFilter \{/);
    assert.match(text, /input UuidFilter \{/);
  });

  it("gives boolean no comparison operators, exactly as core does", () => {
    const config = filterOpsConfigForGroup("boolean");
    assert.equal(config.compare, false);
    assert.equal(config.inList, false);
    const names = filterOpFieldsFor("boolean").map((field) => field.name);
    assert.deepEqual(names, ["eq", "ne"]);
  });

  it("filters a relation column by uuid", () => {
    const text = sdl();
    assert.match(text, /input BookFilter \{[^}]*author: UuidFilter/s);
  });

  it("maps scalar kinds to the right graphql type", () => {
    assert.equal(
      scalarTypeNameFor({ key: "n", kind: "integer", filterGroup: "numeric", system: false }),
      "Int",
    );
    assert.equal(
      scalarTypeNameFor({ key: "n", kind: "real", filterGroup: "numeric", system: false }),
      "Float",
    );
    assert.equal(
      scalarTypeNameFor({ key: "n", kind: "uuid", filterGroup: "uuid", system: false }),
      "UUID",
    );
    assert.equal(
      scalarTypeNameFor({ key: "n", kind: "date", filterGroup: "temporal", system: false }),
      "DateTime",
    );
    assert.equal(
      scalarTypeNameFor({ key: "n", kind: "numeric", filterGroup: "decimal", system: false }),
      "Decimal",
    );
    assert.equal(
      scalarTypeNameFor({ key: "n", kind: "jsonb", filterGroup: "json", system: false }),
      "JSON",
    );
    assert.equal(
      scalarTypeNameFor({ key: "n", kind: "point", filterGroup: "coordinate", system: false }),
      "Coordinate",
    );
    assert.equal(
      scalarTypeNameFor({ key: "n", kind: "text", filterGroup: "string", system: false }),
      "String",
    );
  });

  it("only marks the four always-present system columns non-null", () => {
    assert.equal(
      scalarIsNonNull({ key: "id", kind: "uuid", filterGroup: "uuid", system: true }),
      true,
    );
    assert.equal(
      scalarIsNonNull({ key: "title", kind: "text", filterGroup: "string", system: false }),
      false,
    );
  });
});
