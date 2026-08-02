import {
  GraphQLError,
  OperationTypeNode,
  execute,
  getOperationAST,
  parse,
  validate,
} from "graphql";
import type { DocumentNode, ExecutionResult } from "graphql";

export type { ExecutionResult };
import { emptyListPage } from "@fookiejs/core";
import type { EntityRecord, ListPage } from "@fookiejs/core";
import type { ModelGraph } from "../registry.ts";
import { PrefetchStore } from "../plan/store.ts";
import { defaultLimits, prefetch } from "../plan/prefetch.ts";
import type { PrefetchLimits, ReadPort } from "../plan/prefetch.ts";
import { collectRoots } from "./collect.ts";
import type { MutationPort, SchemaBundle } from "./build.ts";
import { RegistryError } from "../errors.ts";

export type RunRequest = {
  query: string;
  variables: Record<string, unknown>;
  operationName: readonly string[];
};

function pageOf(limit: readonly number[], offset: readonly number[]): ListPage {
  if (Array.isArray(limit) === false) {
    throw RegistryError.create("page limit required");
  }
  if (Array.isArray(offset) === false) {
    throw RegistryError.create("page offset required");
  }
  const page = emptyListPage();
  return { limit, offset, order: page.order };
}

export function isMutation(
  queryDocument: DocumentNode,
  operationName: string | undefined,
): boolean {
  if (queryDocument.definitions.length < 1) {
    return false;
  }
  const operation = getOperationAST(queryDocument, operationName ?? null);
  if (operation === null || operation === undefined) {
    return false;
  }
  if (operation.operation === OperationTypeNode.SUBSCRIPTION) {
    return false;
  }
  return operation.operation === OperationTypeNode.MUTATION;
}

export function parseQuery(text: string): readonly DocumentNode[] {
  if (text.length < 1) {
    return [];
  }
  try {
    const parsed = parse(text);
    if (parsed.definitions.length < 1) {
      return [];
    }
    return [parsed];
  } catch {
    return [];
  }
}

export async function runMutation(
  bundle: SchemaBundle,
  writes: MutationPort,
  request: RunRequest,
): Promise<ExecutionResult> {
  const parsed = parseQuery(request.query);
  for (const queryDocument of parsed) {
    const problems = validate(bundle.schema, queryDocument);
    if (problems.length > 0) {
      return { errors: problems };
    }
    return await execute({
      schema: bundle.schema,
      document: queryDocument,
      variableValues: request.variables,
      operationName: request.operationName[0] ?? null,
      contextValue: { port: writes },
    });
  }
  return { errors: [new GraphQLError("could not parse the operation")] };
}

export async function runQuery(
  bundle: SchemaBundle,
  graph: ModelGraph,
  port: ReadPort,
  request: RunRequest,
  limits: PrefetchLimits = defaultLimits(),
): Promise<ExecutionResult> {
  let queryDocument;
  try {
    queryDocument = parse(request.query);
  } catch (err) {
    return { errors: [new GraphQLError(String(err))] };
  }
  const problems = validate(bundle.schema, queryDocument);
  if (problems.length > 0) {
    return { errors: problems };
  }

  const operationName = request.operationName[0];
  const roots = collectRoots(
    graph,
    queryDocument,
    operationName,
    request.variables,
    bundle.rootFields,
  );

  const store = new PrefetchStore();
  const rootRows = new Map<string, readonly EntityRecord[]>();
  for (const root of roots) {
    const outcome = await prefetch(
      port,
      graph,
      root.modelName,
      root.filter,
      pageOf(root.limit, root.offset),
      root.selections,
      limits,
      store,
    );
    rootRows.set(root.responseKey, outcome.roots);
  }

  return await execute({
    schema: bundle.schema,
    document: queryDocument,
    variableValues: request.variables,
    operationName: operationName ?? null,
    contextValue: { store, roots: rootRows },
  });
}
