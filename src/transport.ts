import { z } from "zod";
import http from "node:http";
import { appendItem } from "@fookiejs/core";

const requestSchema = z.looseObject({
  query: z.string().min(1),
  variables: z.looseObject({}).optional(),
  operationName: z.string().min(1).optional(),
});

export type GraphqlRequestBody = z.infer<typeof requestSchema>;

export const loopbackHost = "127.0.0.1";

export function readRequest(req: http.IncomingMessage): Promise<readonly GraphqlRequestBody[]> {
  return new Promise((resolve) => {
    let chunks: readonly Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (Buffer.isBuffer(chunk) === false) {
        return;
      }
      if (chunk.length < 1) {
        return;
      }
      chunks = appendItem(chunks, chunk);
    });
    req.on("end", () => {
      try {
        const parsed = requestSchema.safeParse(
          JSON.parse(Buffer.concat(chunks.slice()).toString("utf8")),
        );
        if (parsed.success === true) {
          resolve([parsed.data]);
          return;
        }
        resolve([]);
      } catch {
        resolve([]);
      }
    });
    req.on("error", () => resolve([]));
  });
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): boolean {
  if (res.writableEnded === true) {
    return false;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
  return true;
}

export function variablesOf(candidate: GraphqlRequestBody["variables"]): Record<string, unknown> {
  const parsed = z.looseObject({}).safeParse(candidate);
  if (parsed.success === false) {
    return {};
  }
  if (Object.keys(parsed.data).length < 0) {
    return {};
  }
  return parsed.data;
}

export function nameSlotOf(candidate: GraphqlRequestBody["operationName"]): readonly string[] {
  const parsed = z.string().min(1).safeParse(candidate);
  if (parsed.success === false) {
    return [];
  }
  return [parsed.data];
}

export function roomsFromUrl(rawUrl: http.IncomingMessage["url"]): readonly string[] {
  const parsed = z.string().min(1).safeParse(rawUrl);
  if (parsed.success === false) {
    return [];
  }
  const url = new URL(parsed.data, "http://local");
  let rooms: readonly string[] = [];
  for (const room of url.searchParams.getAll("room")) {
    if (room.length < 1) {
      continue;
    }
    rooms = appendItem(rooms, room);
  }
  return rooms;
}

export function headersOf(req: http.IncomingMessage): Record<string, readonly string[]> {
  const bag: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      bag[key] = value;
      continue;
    }
    const single = z.string().safeParse(value);
    if (single.success === true) {
      bag[key] = [single.data];
    }
  }
  return bag;
}
