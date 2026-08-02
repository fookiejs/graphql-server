import { z } from "zod";
import { appendItem, emptyListPage } from "@fookiejs/core";
import type {
  EntityRecord,
  FilterInput,
  ListPage,
  ListResult,
  ModelDef,
  ModelFieldsInput,
} from "@fookiejs/core";
import { QueryTooLargeError, RegistryError } from "../errors.ts";
import { fieldPlanFor } from "../naming.ts";
import type { ModelGraph } from "../registry.ts";
import { PrefetchStore, entityIdOf, relationValueOf } from "./store.ts";

export type Selection = {
  field: string;
  children: readonly Selection[];
};

export type ReadPort = {
  list(
    model: ModelDef<ModelFieldsInput>,
    filter: FilterInput,
    page?: ListPage,
  ): Promise<ListResult<EntityRecord>>;
};

export type PrefetchLimits = {
  maxDepth: number;
  maxRows: number;
  maxInChunk: number;
};

export function defaultLimits(): PrefetchLimits {
  const limits: PrefetchLimits = { maxDepth: 8, maxRows: 50_000, maxInChunk: 1_000 };
  if (limits.maxInChunk < 1) {
    throw RegistryError.create("chunk size must be positive");
  }
  if (limits.maxDepth < 1) {
    throw RegistryError.create("depth must be positive");
  }
  return limits;
}

export function chunksOf(ids: readonly string[], size: number): readonly (readonly string[])[] {
  if (Number.isInteger(size) === false || size < 1) {
    throw RegistryError.create("chunk size must be a positive integer");
  }
  let chunks: readonly (readonly string[])[] = [];
  let cursor = 0;
  while (cursor < ids.length) {
    chunks = appendItem(chunks, ids.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

export function distinct(values: readonly string[]): readonly string[] {
  let unique: readonly string[] = [];
  for (const candidate of values) {
    if (unique.includes(candidate) === false) {
      unique = appendItem(unique, candidate);
    }
  }
  return unique;
}

type Frame = {
  modelName: string;
  rows: readonly EntityRecord[];
  selections: readonly Selection[];
};

type EdgeWork = {
  fieldName: string;
  reverse: boolean;
  fieldKey: string;
  childModel: string;
  children: readonly Selection[];
};

function edgeWorkFor(
  graph: ModelGraph,
  modelName: string,
  selection: Selection,
): readonly EdgeWork[] {
  for (const plan of fieldPlanFor(graph, modelName)) {
    if (plan.name !== selection.field) {
      continue;
    }
    for (const edge of plan.edge) {
      const childModel = plan.reverse ? edge.owner : edge.target;
      return [
        {
          fieldName: plan.name,
          reverse: plan.reverse,
          fieldKey: edge.fieldKey,
          childModel,
          children: selection.children,
        },
      ];
    }
    return [];
  }
  return [];
}

function unknownOnly(
  store: PrefetchStore,
  modelName: string,
  ids: readonly string[],
): readonly string[] {
  let missing: readonly string[] = [];
  for (const id of ids) {
    if (store.knows(modelName, id)) {
      continue;
    }
    missing = appendItem(missing, id);
  }
  return missing;
}

function parentIdsFor(work: EdgeWork, rows: readonly EntityRecord[]): readonly string[] {
  let ids: readonly string[] = [];
  for (const row of rows) {
    if (work.reverse) {
      for (const id of entityIdOf(row)) {
        ids = appendItem(ids, id);
      }
      continue;
    }
    for (const target of relationValueOf(row, work.fieldKey)) {
      ids = appendItem(ids, target);
    }
  }
  return distinct(ids);
}

function ownedChildren(index: Record<string, readonly string[]>, owner: string): readonly string[] {
  const known = index[owner];
  const parsed = z.array(z.string()).safeParse(known);
  if (parsed.success === false) {
    return [];
  }
  if (parsed.data.length < 1) {
    return [];
  }
  return parsed.data;
}

function groupReverse(
  store: PrefetchStore,
  work: EdgeWork,
  parentModel: string,
  parents: readonly EntityRecord[],
  children: readonly EntityRecord[],
): boolean {
  const byOwner: Record<string, readonly string[]> = {};
  for (const child of children) {
    for (const owner of relationValueOf(child, work.fieldKey)) {
      for (const childId of entityIdOf(child)) {
        byOwner[owner] = appendItem(ownedChildren(byOwner, owner), childId);
      }
    }
  }
  for (const parent of parents) {
    for (const parentId of entityIdOf(parent)) {
      store.linkMany(parentModel, parentId, work.fieldName, ownedChildren(byOwner, parentId));
    }
  }
  return true;
}

function groupForward(
  store: PrefetchStore,
  work: EdgeWork,
  parentModel: string,
  parents: readonly EntityRecord[],
): boolean {
  if (Array.isArray(parents) === false) {
    throw RegistryError.create("parent rows required");
  }
  for (const parent of parents) {
    for (const parentId of entityIdOf(parent)) {
      store.linkOne(parentModel, parentId, work.fieldName, relationValueOf(parent, work.fieldKey));
    }
  }
  return true;
}

function knownRows(
  store: PrefetchStore,
  modelName: string,
  ids: readonly string[],
): readonly EntityRecord[] {
  let rows: readonly EntityRecord[] = [];
  for (const id of ids) {
    for (const row of store.entityAt(modelName, id)) {
      rows = appendItem(rows, row);
    }
  }
  return rows;
}

export type PrefetchResult = {
  store: PrefetchStore;
  roots: readonly EntityRecord[];
};

export async function prefetch(
  port: ReadPort,
  graph: ModelGraph,
  rootModel: string,
  rootFilter: FilterInput,
  rootPage: ListPage,
  selections: readonly Selection[],
  limits: PrefetchLimits = defaultLimits(),
  shared: PrefetchStore = new PrefetchStore(),
): Promise<PrefetchResult> {
  if (z.string().min(1).safeParse(rootModel).success === false) {
    throw RegistryError.create("root model required");
  }
  const store = shared;
  const rootEntry = graph.entryFor(rootModel);
  const rootRun = await port.list(rootEntry.model, rootFilter, rootPage);
  let rowsRead = rootRun.results.length;
  for (const row of rootRun.results) {
    store.remember(rootModel, row);
  }

  let frames: readonly Frame[] = [{ modelName: rootModel, rows: rootRun.results, selections }];
  let depth = 0;
  while (frames.length > 0) {
    depth += 1;
    if (depth > limits.maxDepth) {
      throw QueryTooLargeError.create(`query exceeds the maximum depth of ${limits.maxDepth}`);
    }
    let next: readonly Frame[] = [];
    for (const frame of frames) {
      for (const selection of frame.selections) {
        for (const work of edgeWorkFor(graph, frame.modelName, selection)) {
          const ids = parentIdsFor(work, frame.rows);
          if (ids.length === 0) {
            if (work.reverse) {
              groupReverse(store, work, frame.modelName, frame.rows, []);
            }
            continue;
          }
          const childEntry = graph.entryFor(work.childModel);
          const lookupKey = work.reverse ? work.fieldKey : "id";
          const wanted = work.reverse ? ids : unknownOnly(store, work.childModel, ids);
          let fetched: readonly EntityRecord[] = [];
          for (const chunk of chunksOf(wanted, limits.maxInChunk)) {
            const run = await port.list(
              childEntry.model,
              { [lookupKey]: { in: chunk.slice() } },
              emptyListPage(),
            );
            rowsRead += run.results.length;
            if (rowsRead > limits.maxRows) {
              throw QueryTooLargeError.create(`query would read more than ${limits.maxRows} rows`);
            }
            for (const childRow of run.results) {
              store.remember(work.childModel, childRow);
              fetched = appendItem(fetched, childRow);
            }
          }
          if (work.reverse) {
            groupReverse(store, work, frame.modelName, frame.rows, fetched);
          } else {
            groupForward(store, work, frame.modelName, frame.rows);
          }
          const reachable = work.reverse ? fetched : knownRows(store, work.childModel, ids);
          if (work.children.length > 0 && reachable.length > 0) {
            next = appendItem(next, {
              modelName: work.childModel,
              rows: reachable,
              selections: work.children,
            });
          }
        }
      }
    }
    frames = next;
  }
  return { store, roots: rootRun.results };
}
