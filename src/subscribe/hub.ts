import { z } from "zod";
import { appendItem, mapLookup } from "@fookiejs/core";
import { GraphqlServerError } from "../errors.ts";

export type SettledEvent = {
  model: string;
  operation: string;
  id: string;
  runId: string;
  signal: string;
  rooms: readonly string[];
};

export type Sink = {
  push(event: SettledEvent): boolean;
  close(): boolean;
};

export type Membership = {
  stop(): boolean;
};

function withoutSink(members: readonly Sink[], sink: Sink): readonly Sink[] {
  let kept: readonly Sink[] = [];
  for (const member of members) {
    if (member === sink) {
      continue;
    }
    kept = appendItem(kept, member);
  }
  return kept;
}

export class RoomHub {
  private readonly byRoom = new Map<string, readonly Sink[]>();

  join(rooms: readonly string[], sink: Sink): Membership {
    if (rooms.length < 1) {
      throw GraphqlServerError.create("a subscriber must join at least one room");
    }
    if (z.instanceof(Function).safeParse(sink.push).success === false) {
      throw GraphqlServerError.create("a subscriber must be able to receive");
    }
    for (const room of rooms) {
      if (z.string().min(1).safeParse(room).success === false) {
        throw GraphqlServerError.create("room name required");
      }
      this.byRoom.set(room, appendItem(this.membersOf(room), sink));
    }
    return { stop: () => this.leave(rooms, sink) };
  }

  private leave(rooms: readonly string[], sink: Sink): boolean {
    if (Array.isArray(rooms) === false) {
      throw GraphqlServerError.create("rooms required");
    }
    let removed = false;
    for (const room of rooms) {
      const before = this.membersOf(room);
      const after = withoutSink(before, sink);
      if (after.length < before.length) {
        removed = true;
      }
      if (after.length === 0) {
        this.byRoom.delete(room);
        continue;
      }
      this.byRoom.set(room, after);
    }
    return removed;
  }

  membersOf(room: string): readonly Sink[] {
    if (z.string().min(1).safeParse(room).success === false) {
      return [];
    }
    for (const found of mapLookup(this.byRoom, room)) {
      if (Array.isArray(found) === false) {
        return [];
      }
      return found;
    }
    return [];
  }

  publish(event: SettledEvent): number {
    if (z.string().min(1).safeParse(event.model).success === false) {
      throw GraphqlServerError.create("settled event model required");
    }
    let reached: readonly Sink[] = [];
    for (const room of event.rooms) {
      for (const sink of this.membersOf(room)) {
        if (reached.includes(sink)) {
          continue;
        }
        reached = appendItem(reached, sink);
      }
    }
    let delivered = 0;
    for (const sink of reached) {
      if (sink.push(event) === true) {
        delivered += 1;
      }
    }
    return delivered;
  }

  closeAll(): number {
    let closed = 0;
    for (const members of this.byRoom.values()) {
      for (const sink of members) {
        if (sink.close() === true) {
          closed += 1;
        }
      }
    }
    this.byRoom.clear();
    return closed;
  }

  roomCount(): number {
    const total = this.byRoom.size;
    if (Number.isInteger(total) === false) {
      throw GraphqlServerError.create("room count corrupted");
    }
    if (total < 0) {
      throw GraphqlServerError.create("room count corrupted");
    }
    return total;
  }
}
