import { z } from "zod";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Done, Model, Types } from "@fookiejs/core";
import { ModelGraph } from "../src/registry.ts";
import { fieldPlanFor, pluralOf, reverseFieldNameFor } from "../src/naming.ts";

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

const user = Model({ name: "User", fields: { email: z.string().email() }, flow: passthrough });

const publisher = Model({ name: "Publisher", fields: { title: z.string() }, flow: passthrough });

const book = Model({
  name: "Book",
  fields: {
    title: z.string(),
    pages: z.number().int(),
    author: Types.relation({ name: "User" }),
    publisher: Types.relation({ name: "Publisher" }),
  },
  flow: passthrough,
});

const message = Model({
  name: "Message",
  fields: {
    body: z.string(),
    sender: Types.relation({ name: "User" }),
    recipient: Types.relation({ name: "User" }),
  },
  flow: passthrough,
});

const employee = Model({
  name: "Employee",
  fields: { name: z.string(), manager: Types.relation({ name: "Employee" }) },
  flow: passthrough,
});

describe("model graph", () => {
  it("finds forward edges for the Types.relation form", () => {
    const graph = ModelGraph.create([user, publisher, book]);
    const entry = graph.entryFor("Book");
    assert.deepEqual(
      entry.forward.map((edge) => `${edge.fieldKey}->${edge.target}`),
      ["author->User", "publisher->Publisher"],
    );
  });

  it("finds forward edges for a bare model reference too", () => {
    const owner = Model({ name: "RefOwner", fields: { tag: z.string() }, flow: passthrough });
    const note = Model({ name: "RefNote", fields: { owner }, flow: passthrough });
    const graph = ModelGraph.create([owner, note]);
    assert.deepEqual(
      graph.entryFor("RefNote").forward.map((edge) => edge.target),
      ["RefOwner"],
    );
  });

  it("separates scalars from relations and marks system fields", () => {
    const graph = ModelGraph.create([user, publisher, book]);
    const entry = graph.entryFor("Book");
    const keys = entry.scalars.map((scalar) => scalar.key);
    assert.ok(keys.includes("title"));
    assert.ok(keys.includes("pages"));
    assert.equal(keys.includes("author"), false, "a relation is not a scalar");
    const system = entry.scalars.filter((scalar) => scalar.system).map((scalar) => scalar.key);
    assert.ok(system.includes("id"));
    assert.ok(system.includes("createdAt"));
  });

  it("synthesizes reverse edges by inverting the forward list", () => {
    const graph = ModelGraph.create([user, publisher, book]);
    assert.deepEqual(
      graph.reverseOf("User").map((edge) => `${edge.owner}.${edge.fieldKey}`),
      ["Book.author"],
    );
    assert.deepEqual(graph.reverseOf("Book"), []);
  });

  it("refuses a relation pointing at an unregistered model", () => {
    assert.throws(
      () => ModelGraph.create([book]),
      /Book\.author points at unregistered model User/,
    );
  });

  it("refuses the same model twice", () => {
    assert.throws(() => ModelGraph.create([user, user]), /registered twice/);
  });
});

describe("naming", () => {
  it("pluralises without an irregular-noun dictionary", () => {
    assert.equal(pluralOf("book"), "books");
    assert.equal(pluralOf("category"), "categories");
    assert.equal(pluralOf("day"), "days");
    assert.equal(pluralOf("address"), "addresses");
    assert.equal(pluralOf("box"), "boxes");
  });

  it("names a single reverse relation after the child model", () => {
    const graph = ModelGraph.create([user, publisher, book]);
    const plans = fieldPlanFor(graph, "User");
    const names = plans.filter((plan) => plan.reverse).map((plan) => plan.name);
    assert.deepEqual(names, ["books"]);
  });

  it("disambiguates two relations from the same child model", () => {
    const graph = ModelGraph.create([user, message]);
    const incoming = graph.reverseOf("User");
    assert.equal(incoming.length, 2);
    const names = incoming.map((edge) => reverseFieldNameFor(edge, incoming));
    assert.deepEqual(names, ["messagesBySender", "messagesByRecipient"]);
  });

  it("drops a trailing Id from the object field but keeps the raw column", () => {
    const post = Model({
      name: "Post",
      fields: { title: z.string(), authorId: Types.relation({ name: "User" }) },
      flow: passthrough,
    });
    const graph = ModelGraph.create([user, post]);
    const names = fieldPlanFor(graph, "Post").map((plan) => plan.name);
    assert.ok(names.includes("authorId"), "the raw uuid column stays addressable");
    assert.ok(names.includes("author"), "the object field drops the Id suffix");
  });

  it("handles a self reference without looping", () => {
    const graph = ModelGraph.create([employee]);
    const plans = fieldPlanFor(graph, "Employee");
    const names = plans.map((plan) => plan.name);
    assert.ok(names.includes("manager"));
    assert.ok(names.includes("employees"));
  });
});
