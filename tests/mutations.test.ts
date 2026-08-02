import { z } from "zod";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { Done, External, Model, Types, app } from "@fookiejs/core";
import { graphqlServer } from "../src/server.ts";

const databaseUrl = process.env.FOOKIE_TEST_DATABASE ?? "";

const audit = External({
  name: "mut.audit",
  input: { note: z.string() },
  output: { logged: z.boolean() },
  attempts: 2,
  backoff: "fixed",
  timeoutMs: 30_000,
});

const team = Model({
  name: "MutTeam",
  fields: { label: z.string() },
  flow: {
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
  },
});

const player = Model({
  name: "MutPlayer",
  fields: { name: z.string(), shirt: z.number().int(), team: Types.relation({ name: "MutTeam" }) },
  flow: {
    async create() {
      return Done;
    },
    async list() {
      return Done;
    },
    async update(flow) {
      const settled = await flow.external(audit, { note: "updated" });
      return settled.signal;
    },
    async delete() {
      return Done;
    },
  },
});

describe("graphql mutations", { skip: databaseUrl.length === 0 }, () => {
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
      models: [team, player],
      externals: [audit] as const,
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

  it("creates a row and reads it back through a query", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie);
    const stamp = `${Date.now()}`;

    const made = await server.execute(
      `mutation { createMutTeam(body: { label: "team-${stamp}" }) { signal id runId } }`,
    );
    assert.equal(made.errors, undefined, JSON.stringify(made.errors));
    const created = made.data?.createMutTeam as Record<string, unknown>;
    assert.equal(created.signal, "DONE");
    assert.match(String(created.id), /^[0-9a-f-]{36}$/);
    assert.ok(String(created.runId).length > 0);

    const read = await server.execute(
      `{ mutTeams(filter: { label: { eq: "team-${stamp}" } }) { label } }`,
    );
    const rows = (read.data?.mutTeams ?? []) as readonly Record<string, unknown>[];
    assert.equal(rows.length, 1);

    await server.stop();
    await fookie.stop();
  });

  it("reports a suspended saga as running rather than as an error", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie);
    const stamp = `${Date.now()}b`;

    const madeTeam = await fookie.create(team, { label: `t-${stamp}` });
    if (madeTeam.signal !== "done") {
      throw new Error("team must be created");
    }
    const madePlayer = await fookie.create(player, {
      name: `p-${stamp}`,
      shirt: 9,
      team: madeTeam.id,
    });
    if (madePlayer.signal !== "done") {
      throw new Error("player must be created");
    }

    const changed = await server.execute(
      `mutation Rename($id: UUID!) {
         updateMutPlayer(id: $id, body: { name: "renamed" }) { signal id runId }
       }`,
      { id: madePlayer.id },
    );
    assert.equal(changed.errors, undefined, JSON.stringify(changed.errors));
    const outcome = changed.data?.updateMutPlayer as Record<string, unknown>;
    assert.equal(outcome.signal, "RUNNING", "a suspended flow is data, not a GraphQL error");
    assert.equal(outcome.id, madePlayer.id);
    assert.ok(String(outcome.runId).length > 0, "the client gets a handle to follow");

    await server.stop();
    await fookie.stop();
  });

  it("deletes through the mutation surface", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie);
    const stamp = `${Date.now()}c`;
    const made = await fookie.create(team, { label: `gone-${stamp}` });
    if (made.signal !== "done") {
      throw new Error("team must be created");
    }

    const removed = await server.execute(
      `mutation Drop($id: UUID!) { deleteMutTeam(id: $id) { signal id } }`,
      { id: made.id },
    );
    assert.equal(removed.errors, undefined, JSON.stringify(removed.errors));
    const outcome = removed.data?.deleteMutTeam as Record<string, unknown>;
    assert.equal(outcome.signal, "DONE");

    const read = await server.execute(
      `{ mutTeams(filter: { label: { eq: "gone-${stamp}" } }) { label } }`,
    );
    const rows = (read.data?.mutTeams ?? []) as readonly Record<string, unknown>[];
    assert.equal(rows.length, 0, "the soft delete is invisible to reads");

    await server.stop();
    await fookie.stop();
  });

  it("refuses a create that omits a required field", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie);
    const outcome = await server.execute(`mutation { createMutTeam(body: {}) { signal } }`);
    assert.ok(outcome.errors !== undefined, "the schema requires every domain column");
    await server.stop();
    await fookie.stop();
  });
});
