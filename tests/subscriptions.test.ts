import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoomHub } from "../src/subscribe/hub.ts";
import type { SettledEvent, Sink } from "../src/subscribe/hub.ts";
import { frameOf, maxBufferedBytes } from "../src/subscribe/sse.ts";

function recordingSink(): Sink & { seen: SettledEvent[]; closed: boolean[] } {
  const seen: SettledEvent[] = [];
  const closed: boolean[] = [];
  return {
    seen,
    closed,
    push(event) {
      seen.push(event);
      return true;
    },
    close() {
      closed.push(true);
      return true;
    },
  };
}

function eventFor(rooms: readonly string[]): SettledEvent {
  return {
    model: "Order",
    operation: "create",
    id: "00000000-0000-7000-8000-000000000001",
    runId: "run-1",
    signal: "done",
    rooms,
  };
}

describe("room hub", () => {
  it("delivers only to the rooms the event names", () => {
    const hub = new RoomHub();
    const acme = recordingSink();
    const other = recordingSink();
    hub.join(["org:acme"], acme);
    hub.join(["org:other"], other);

    const delivered = hub.publish(eventFor(["org:acme"]));
    assert.equal(delivered, 1);
    assert.equal(acme.seen.length, 1);
    assert.equal(other.seen.length, 0, "a subscriber in another room hears nothing");
  });

  it("sends an event to a subscriber only once even across several rooms", () => {
    const hub = new RoomHub();
    const both = recordingSink();
    hub.join(["org:acme", "team:red"], both);

    hub.publish(eventFor(["org:acme", "team:red"]));
    assert.equal(both.seen.length, 1, "one delivery, not one per matching room");
  });

  it("delivers nothing when the flow named no room", () => {
    const hub = new RoomHub();
    const listener = recordingSink();
    hub.join(["org:acme"], listener);

    const delivered = hub.publish(eventFor([]));
    assert.equal(delivered, 0, "no rooms means the event goes nowhere");
    assert.equal(listener.seen.length, 0);
  });

  it("stops delivering once the membership ends", () => {
    const hub = new RoomHub();
    const listener = recordingSink();
    const membership = hub.join(["org:acme"], listener);

    hub.publish(eventFor(["org:acme"]));
    assert.equal(membership.stop(), true);
    hub.publish(eventFor(["org:acme"]));
    assert.equal(listener.seen.length, 1, "the second event finds nobody");
    assert.equal(hub.roomCount(), 0, "an empty room is forgotten");
  });

  it("refuses a subscriber that joins no room", () => {
    const hub = new RoomHub();
    assert.throws(() => hub.join([], recordingSink()), /at least one room/);
  });

  it("closes every subscriber on shutdown", () => {
    const hub = new RoomHub();
    const first = recordingSink();
    const second = recordingSink();
    hub.join(["a"], first);
    hub.join(["b"], second);

    assert.equal(hub.closeAll(), 2);
    assert.equal(first.closed.length, 1);
    assert.equal(second.closed.length, 1);
    assert.equal(hub.roomCount(), 0);
  });
});

describe("sse framing", () => {
  it("emits a graphql-sse next frame carrying the event and no payload", () => {
    const frame = frameOf(eventFor(["org:acme"]));
    assert.match(frame, /^event: next\n/);
    assert.match(frame, /\n\n$/);

    const body = frame.slice(frame.indexOf("data: ") + 6, frame.length - 2);
    const parsed = JSON.parse(body) as { data: { events: Record<string, unknown> } };
    assert.deepEqual(parsed.data.events, {
      model: "Order",
      operation: "create",
      id: "00000000-0000-7000-8000-000000000001",
      runId: "run-1",
      signal: "DONE",
    });
    assert.equal("entity" in parsed.data.events, false, "no row data crosses the wire");
  });

  it("caps buffered bytes, not lifetime deliveries", () => {
    assert.equal(maxBufferedBytes, 1_048_576);
  });
});
