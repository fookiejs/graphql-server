import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GateFullError, QueryGate, defaultBudget } from "../src/gate.ts";

function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function deferred(): { promise: Promise<void>; settle: () => void } {
  let settle = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("query gate", () => {
  it("lets exactly the budgeted number of queries hold a connection at once", async () => {
    const gate = QueryGate.create({ concurrent: 2, queued: 8 });
    const first = deferred();
    const second = deferred();
    const third = deferred();

    const running = [
      gate.run(async () => await first.promise),
      gate.run(async () => await second.promise),
      gate.run(async () => await third.promise),
    ];
    await tick();

    assert.equal(gate.active(), 2, "the third query must not have pinned a client");
    assert.equal(gate.waiting(), 1);

    first.settle();
    await tick();
    assert.equal(gate.active(), 2, "the waiter takes the freed slot");
    assert.equal(gate.waiting(), 0);

    second.settle();
    third.settle();
    await Promise.all(running);
    assert.equal(gate.active(), 0);
  });

  it("refuses rather than queueing without bound", async () => {
    const gate = QueryGate.create({ concurrent: 1, queued: 1 });
    const held = deferred();
    const queued = deferred();

    const running = [
      gate.run(async () => await held.promise),
      gate.run(async () => await queued.promise),
    ];
    await tick();

    await assert.rejects(
      async () => await gate.run(async () => undefined),
      (caught: Error) => caught instanceof GateFullError,
      "the third caller must be told to come back, not parked forever",
    );

    held.settle();
    queued.settle();
    await Promise.all(running);
  });

  it("frees the slot even when the query throws", async () => {
    const gate = QueryGate.create({ concurrent: 1, queued: 1 });
    await assert.rejects(
      async () =>
        await gate.run(async () => {
          throw new Error("the read blew up");
        }),
      /the read blew up/,
    );
    assert.equal(gate.active(), 0, "a failed query must not leak its connection");
    assert.equal(await gate.run(async () => true), true);
  });

  it("serves waiters in the order they arrived", async () => {
    const gate = QueryGate.create({ concurrent: 1, queued: 4 });
    const order: number[] = [];
    const held = deferred();

    const recorder = (index: number) => async () => {
      order.push(index);
    };
    const running = [gate.run(async () => await held.promise)];
    await tick();
    for (const index of [1, 2, 3]) {
      running.push(gate.run(recorder(index)));
      await tick();
    }

    held.settle();
    await Promise.all(running);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it("rejects a budget that is not a positive integer", () => {
    assert.throws(() => QueryGate.create({ concurrent: 0, queued: 4 }), /positive integer/);
    assert.throws(() => QueryGate.create({ concurrent: 2, queued: 1.5 }), /positive integer/);
  });

  it("defaults to a budget an ordinary pool can actually satisfy", () => {
    const budget = defaultBudget();
    assert.equal(budget.concurrent, 8);
    assert.equal(budget.queued, 64);
  });
});
