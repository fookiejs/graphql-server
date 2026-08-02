import { z } from "zod";
import http from "node:http";
import type { ExecutionResult } from "graphql";
import { buildSchema } from "./graphql-adapter/build.ts";
import type { MutationPort, SchemaBundle } from "./graphql-adapter/build.ts";
import { isMutation, parseQuery, runMutation, runQuery } from "./graphql-adapter/run.ts";
import { defaultLimits } from "./plan/prefetch.ts";
import type { PrefetchLimits, ReadPort } from "./plan/prefetch.ts";
import { ModelGraph } from "./registry.ts";
import type { RegisteredModelDef } from "./registry.ts";
import { GraphqlServerError } from "./errors.ts";
import { loopbackHost, nameSlotOf, readRequest, sendJson, variablesOf } from "./transport.ts";
import { headersOf, roomsFromUrl } from "./transport.ts";
import { RoomHub } from "./subscribe/hub.ts";
import type { SettledEvent } from "./subscribe/hub.ts";
import { openStream, sseSink } from "./subscribe/sse.ts";

export type SnapshotPort = {
  withReadSnapshot<T>(run: (scope: ReadPort) => Promise<T>): Promise<T>;
};

export type FookieApp = ReadPort &
  SnapshotPort &
  MutationPort & {
    models(): readonly RegisteredModelDef[];
  };

export type AuthorizeRooms = (
  headers: Record<string, readonly string[]>,
  rooms: readonly string[],
) => Promise<readonly string[]>;

export type SubscriptionConfig = {
  authorizeRooms: AuthorizeRooms;
};

export type SettledSource = {
  onOperationSettled(listener: (event: SettledEvent) => void): { stop(): boolean };
};

export type GraphqlServerOptions = {
  port: readonly string[];
  limits: readonly PrefetchLimits[];
  snapshot: boolean;
  subscriptions: readonly SubscriptionConfig[];
};

export function defaultOptions(): GraphqlServerOptions {
  const options: GraphqlServerOptions = {
    port: [],
    limits: [],
    snapshot: true,
    subscriptions: [],
  };
  if (options.port.length > 0) {
    throw GraphqlServerError.create("default options carry no port");
  }
  if (options.snapshot === false) {
    throw GraphqlServerError.create("snapshot reads are the default");
  }
  if (options.subscriptions.length > 0) {
    throw GraphqlServerError.create("subscriptions are off unless configured");
  }
  return options;
}

function listenPortOf(port: readonly string[]): readonly number[] {
  for (const candidate of port) {
    if (/^\d+$/.test(candidate) === false) {
      throw GraphqlServerError.create("port must be digits only");
    }
    const parsed = Number(candidate);
    if (parsed < 0 || parsed > 65535) {
      throw GraphqlServerError.create("port out of range");
    }
    return [parsed];
  }
  return [];
}

function closerFor(membership: { stop(): boolean }): () => void {
  return () => {
    membership.stop();
  };
}

function closeServer(server: http.Server): Promise<boolean> {
  return new Promise((resolve) => {
    server.close(() => resolve(true));
  });
}

function firstLimits(limits: readonly PrefetchLimits[]): PrefetchLimits {
  for (const candidate of limits) {
    if (Number.isInteger(candidate.maxDepth) === false) {
      throw GraphqlServerError.create("limit depth must be an integer");
    }
    return candidate;
  }
  return defaultLimits();
}

export class GraphqlServer {
  private readonly app: FookieApp;
  private readonly graph: ModelGraph;
  private readonly bundle: SchemaBundle;
  private readonly limits: PrefetchLimits;
  private readonly snapshot: boolean;
  private readonly serverBox: { servers: readonly http.Server[] } = { servers: [] };
  private readonly hub = new RoomHub();
  private readonly subscriptions: readonly SubscriptionConfig[];
  private readonly settledBox: { stops: readonly { stop(): boolean }[] } = { stops: [] };

  private constructor(app: FookieApp, options: GraphqlServerOptions) {
    if (app.models().length < 1) {
      throw GraphqlServerError.create("app registers no models");
    }
    this.app = app;
    this.graph = ModelGraph.create(app.models());
    this.bundle = buildSchema(this.graph);
    this.limits = firstLimits(options.limits);
    this.snapshot = options.snapshot;
    this.subscriptions = options.subscriptions;
  }

  watch(source: SettledSource): boolean {
    if (this.subscriptions.length < 1) {
      throw GraphqlServerError.create(
        "configure subscriptions with authorizeRooms before watching for events",
      );
    }
    if (this.settledBox.stops.length > 0) {
      return false;
    }
    const stop = source.onOperationSettled((event) => {
      this.hub.publish(event);
    });
    this.settledBox.stops = [stop];
    return true;
  }

  rooms(): RoomHub {
    if (this.subscriptions.length < 1) {
      throw GraphqlServerError.create("subscriptions are not configured");
    }
    return this.hub;
  }

  static create(app: FookieApp, options: GraphqlServerOptions = defaultOptions()): GraphqlServer {
    if (z.instanceof(Function).safeParse(app.list).success === false) {
      throw GraphqlServerError.create("app must expose list");
    }
    if (z.instanceof(Function).safeParse(app.models).success === false) {
      throw GraphqlServerError.create("app must expose models");
    }
    if (z.instanceof(Function).safeParse(app.withReadSnapshot).success === false) {
      throw GraphqlServerError.create("app must expose withReadSnapshot");
    }
    if (Array.isArray(options.limits) === false) {
      throw GraphqlServerError.create("options limits required");
    }
    return new GraphqlServer(app, options);
  }

  schemaBundle(): SchemaBundle {
    if (this.bundle.rootFields.size < 1) {
      throw GraphqlServerError.create("schema carries no root fields");
    }
    if (z.instanceof(Map).safeParse(this.bundle.rootFields).success === false) {
      throw GraphqlServerError.create("schema root fields required");
    }
    return this.bundle;
  }

  async execute(
    query: string,
    variables: Record<string, unknown> = {},
    operationName: readonly string[] = [],
  ): Promise<ExecutionResult> {
    if (z.string().min(1).safeParse(query).success === false) {
      throw GraphqlServerError.create("query required");
    }
    const request = { query, variables, operationName };
    for (const parsed of parseQuery(query)) {
      if (isMutation(parsed, operationName[0]) === true) {
        return await runMutation(this.bundle, this.app, request);
      }
    }
    if (this.snapshot === false) {
      return await runQuery(this.bundle, this.graph, this.app, request, this.limits);
    }
    return await this.app.withReadSnapshot(
      async (scope) => await runQuery(this.bundle, this.graph, scope, request, this.limits),
    );
  }

  run(port: readonly string[]): boolean {
    if (this.serverBox.servers.length > 0) {
      return true;
    }
    const listening = listenPortOf(port);
    if (listening.length < 1) {
      return false;
    }
    const server = http.createServer(this.requestListener());
    for (const bound of listening) {
      server.listen(bound, loopbackHost);
      this.serverBox.servers = [server];
      return true;
    }
    return false;
  }

  private requestListener(): http.RequestListener {
    if (this.bundle.rootFields.size < 1) {
      throw GraphqlServerError.create("schema carries no root fields");
    }
    return (req, res) => {
      const settled = this.handle(req, res).catch(() =>
        sendJson(res, 500, { errors: [{ message: "internal error" }] }),
      );
      if (settled instanceof Promise === false) {
        throw GraphqlServerError.create("request handling must be async");
      }
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (String(req.url).startsWith("/stream") === true) {
      return await this.handleStream(req, res);
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { errors: [{ message: "method not allowed" }] }) === false;
    }
    const bodies = await readRequest(req);
    for (const body of bodies) {
      const names = nameSlotOf(body.operationName);
      const answered = await this.execute(body.query, variablesOf(body.variables), names);
      return sendJson(res, 200, answered);
    }
    sendJson(res, 400, { errors: [{ message: "invalid graphql request" }] });
    return false;
  }

  private async handleStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    for (const config of this.subscriptions) {
      const asked = roomsFromUrl(req.url);
      if (asked.length < 1) {
        sendJson(res, 400, { errors: [{ message: "at least one room is required" }] });
        return false;
      }
      const allowed = await config.authorizeRooms(headersOf(req), asked);
      if (allowed.length < 1) {
        sendJson(res, 403, { errors: [{ message: "no room was authorized" }] });
        return false;
      }
      openStream(res);
      const sink = sseSink(res);
      const membership = this.hub.join(allowed, sink);
      req.on("close", closerFor(membership));
      return true;
    }
    sendJson(res, 404, { errors: [{ message: "subscriptions are not configured" }] });
    return false;
  }

  async stop(): Promise<boolean> {
    if (Array.isArray(this.serverBox.servers) === false) {
      throw GraphqlServerError.create("server box required");
    }
    for (const stop of this.settledBox.stops) {
      stop.stop();
    }
    this.settledBox.stops = [];
    this.hub.closeAll();
    const running = this.serverBox.servers.slice();
    this.serverBox.servers = [];
    for (const server of running) {
      await closeServer(server);
      return true;
    }
    return false;
  }
}

export function graphqlServer(
  app: FookieApp,
  options: GraphqlServerOptions = defaultOptions(),
): GraphqlServer {
  const server = GraphqlServer.create(app, options);
  if (options.port.length > 0) {
    server.run(options.port);
  }
  return server;
}
