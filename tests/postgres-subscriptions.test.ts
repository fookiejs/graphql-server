import { z } from "zod";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { Done, Model, app } from "@fookiejs/core";
import { graphqlServer } from "../src/server.ts";

const databaseUrl = process.env.FOOKIE_TEST_DATABASE ?? "";

const ticket = Model({
  name: "SubTicket",
  fields: { subject: z.string(), tenant: z.string() },
  flow: {
    async create(flow) {
      flow.room(`tenant:${flow.body.tenant}`);
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

const quiet = Model({
  name: "SubQuiet",
  fields: { note: z.string() },
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

async function readFrames(url: string, until: number, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("stream has no body");
  }
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("event: next").length - 1 < until) {
    const chunk = await reader.read();
    if (chunk.done === true) {
      break;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe("subscriptions over sse", { skip: databaseUrl.length === 0 }, () => {
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
      models: [ticket, quiet],
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

  it("streams an event to the room the flow chose", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie, {
      port: ["24781"],
      limits: [],
      snapshot: true,
      budget: [],
      subscriptions: [{ authorizeRooms: async (_headers, rooms) => rooms }],
    });
    server.watch(fookie);

    const abort = new AbortController();
    const frames = readFrames("http://127.0.0.1:24781/stream?room=tenant:acme", 1, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const made = await fookie.create(ticket, { subject: "help", tenant: "acme" });
    assert.equal(made.signal, "done");

    const text = await frames;
    assert.match(text, /event: next/);
    assert.match(text, /"model":"SubTicket"/);
    assert.match(text, /"operation":"create"/);
    assert.match(text, /"signal":"DONE"/);
    assert.equal(text.includes("help"), false, "the subject never crosses the wire");

    abort.abort();
    await server.stop();
    await fookie.stop();
  });

  it("does not stream to a room the flow did not name", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie, {
      port: ["24782"],
      limits: [],
      snapshot: true,
      budget: [],
      subscriptions: [{ authorizeRooms: async (_headers, rooms) => rooms }],
    });
    server.watch(fookie);

    const abort = new AbortController();
    const response = await fetch("http://127.0.0.1:24782/stream?room=tenant:other", {
      signal: abort.signal,
    });
    assert.equal(response.status, 200);

    await fookie.create(ticket, { subject: "help", tenant: "acme" });
    await fookie.create(quiet, { note: "nobody hears this" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(server.rooms().membersOf("tenant:other").length, 1, "the listener is subscribed");
    assert.equal(
      server.rooms().membersOf("tenant:acme").length,
      0,
      "and it is not in the room the event went to",
    );

    abort.abort();
    await server.stop();
    await fookie.stop();
  });

  it("refuses a stream when no room is authorized", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie, {
      port: ["24783"],
      limits: [],
      snapshot: true,
      budget: [],
      subscriptions: [{ authorizeRooms: async () => [] }],
    });
    server.watch(fookie);

    const response = await fetch("http://127.0.0.1:24783/stream?room=tenant:acme");
    assert.equal(response.status, 403);
    await response.text();

    await server.stop();
    await fookie.stop();
  });

  it("refuses a stream that asks for no room at all", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie, {
      port: ["24784"],
      limits: [],
      snapshot: true,
      budget: [],
      subscriptions: [{ authorizeRooms: async (_headers, rooms) => rooms }],
    });

    const response = await fetch("http://127.0.0.1:24784/stream");
    assert.equal(response.status, 400);
    await response.text();

    await server.stop();
    await fookie.stop();
  });

  it("will not watch for events unless subscriptions are configured", async () => {
    const fookie = boot();
    const server = graphqlServer(fookie);
    assert.throws(() => server.watch(fookie), /authorizeRooms/);
    await server.stop();
    await fookie.stop();
  });
});
