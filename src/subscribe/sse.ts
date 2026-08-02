import http from "node:http";
import type { SettledEvent, Sink } from "./hub.ts";

export const heartbeatMs = 15_000;

export const maxBufferedBytes = 1_048_576;

export const completeFrame = `event: complete\ndata: {}\n\n`;

export type SseSink = Sink & {
  queued(): number;
};

export function frameOf(event: SettledEvent): string {
  const payload = {
    data: {
      events: {
        model: event.model,
        operation: event.operation,
        id: event.id,
        runId: event.runId,
        signal: event.signal.toUpperCase(),
      },
    },
  };
  return `event: next\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function openStream(res: http.ServerResponse): boolean {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(":ok\n\n");
  return true;
}

export function sseSink(res: http.ServerResponse): SseSink {
  const state: { closed: boolean } = { closed: false };
  const timer = setInterval(() => {
    if (state.closed === true) {
      return;
    }
    res.write(":ping\n\n");
  }, heartbeatMs);
  timer.unref();
  return {
    push(event) {
      if (state.closed === true) {
        return false;
      }
      if (res.writableLength > maxBufferedBytes) {
        res.write(completeFrame);
        state.closed = true;
        clearInterval(timer);
        res.end();
        return false;
      }
      res.write(frameOf(event));
      return true;
    },
    close() {
      if (state.closed === true) {
        return false;
      }
      state.closed = true;
      clearInterval(timer);
      res.write("event: complete\ndata: {}\n\n");
      res.end();
      return true;
    },
    queued() {
      return res.writableLength;
    },
  };
}
