import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";
import type {
  GraphQLFieldConfigMap,
  GraphQLInputFieldConfigMap,
  GraphQLInputType,
  GraphQLOutputType,
} from "graphql";
import type { FilterGroup } from "@fookiejs/core";
import { z } from "zod";
import type {
  EntityFieldsOf,
  EntityRecord,
  FilterInput,
  InferCreateBody,
  ModelDef,
  ModelFieldsInput,
  UpdateBody,
} from "@fookiejs/core";
import { RegistryError } from "../errors.ts";
import type { PrefetchStore } from "../plan/store.ts";
import { fieldPlanFor } from "../naming.ts";
import type { ModelGraph } from "../registry.ts";
import { filterInputNameFor, filterOpFieldsFor } from "../schema/filters.ts";
import { scalarIsNonNull, scalarTypeNameFor } from "../schema/scalars.ts";
import type { ScalarTypeName } from "../schema/scalars.ts";
import { scalarTypeFor } from "./scalars.ts";

const allGroups: readonly FilterGroup[] = [
  "numeric",
  "bigint",
  "decimal",
  "temporal",
  "string",
  "uuid",
  "boolean",
  "coordinate",
  "json",
  "geometric",
  "binary",
];

const groupScalar: Record<string, ScalarTypeName> = {
  numeric: "Float",
  bigint: "Decimal",
  decimal: "Decimal",
  temporal: "DateTime",
  string: "String",
  uuid: "UUID",
  boolean: "Boolean",
  coordinate: "Coordinate",
  json: "JSON",
  geometric: "String",
  binary: "String",
};

export const OrderDirectionEnum = new GraphQLEnumType({
  name: "OrderDirection",
  values: { ASC: { value: "asc" }, DESC: { value: "desc" } },
});

export const SignalEnum = new GraphQLEnumType({
  name: "Signal",
  values: { DONE: { value: "done" }, RUNNING: { value: "running" }, FAILED: { value: "failed" } },
});

function filterInputFor(group: FilterGroup): GraphQLInputObjectType | undefined {
  const opFields = filterOpFieldsFor(group);
  const scalar = scalarTypeFor(groupScalar[group] ?? "String");
  const fields: GraphQLInputFieldConfigMap = {};
  for (const opField of opFields) {
    if (opField.operand === "list") {
      fields[opField.name] = { type: new GraphQLList(new GraphQLNonNull(scalar)) };
      continue;
    }
    if (opField.operand === "text") {
      fields[opField.name] = { type: GraphQLString };
      continue;
    }
    if (opField.operand === "near") {
      fields[opField.name] = { type: new GraphQLList(new GraphQLNonNull(GraphQLInt)) };
      continue;
    }
    fields[opField.name] = { type: scalar };
  }
  if (Object.keys(fields).length === 0) {
    return undefined;
  }
  return new GraphQLInputObjectType({ name: filterInputNameFor(group), fields });
}

export type ExecutionContext = {
  store: PrefetchStore;
  roots: Map<string, readonly EntityRecord[]>;
};

function storeOf(context: unknown): ExecutionContext {
  if (z.looseObject({}).safeParse(context).success === false) {
    throw RegistryError.create("execution context required");
  }
  const ctx = context as ExecutionContext;
  if (z.instanceof(Map).safeParse(ctx.roots).success === false) {
    throw RegistryError.create("execution context roots required");
  }
  return ctx;
}

function idSlotOf(source: unknown): readonly string[] {
  const parsed = z.looseObject({ id: z.string().min(1) }).safeParse(source);
  if (parsed.success === false) {
    return [];
  }
  if (parsed.data.id.length < 1) {
    return [];
  }
  return [parsed.data.id];
}

function countSlotOf(candidate: unknown): readonly number[] {
  const parsed = z.number().int().nonnegative().safeParse(candidate);
  if (parsed.success === false) {
    return [];
  }
  if (Number.isInteger(parsed.data) === false) {
    return [];
  }
  return [parsed.data];
}

function responseKeyOf(fieldInfo: { path: { key: string | number } }): string {
  const key = String(fieldInfo.path.key);
  if (key.length < 1) {
    throw RegistryError.create("root response key required");
  }
  if (z.string().min(1).safeParse(key).success === false) {
    throw RegistryError.create("root response key required");
  }
  return key;
}

function resolveRootMany(context: unknown, fieldInfo: { path: { key: string | number } }): unknown {
  const ctx = storeOf(context);
  const key = responseKeyOf(fieldInfo);
  const rows = ctx.roots.get(key);
  if (rows === undefined) {
    return [];
  }
  return rows;
}

function resolveRootSingle(
  context: unknown,
  fieldInfo: { path: { key: string | number } },
): unknown {
  const ctx = storeOf(context);
  const key = responseKeyOf(fieldInfo);
  const rows = ctx.roots.get(key);
  if (rows === undefined) {
    return null;
  }
  return rows[0] ?? null;
}

function resolveMany(
  context: unknown,
  parentModel: string,
  source: unknown,
  fieldName: string,
  childModel: string,
  args: Record<string, unknown>,
): unknown {
  const ctx = storeOf(context);
  for (const id of idSlotOf(source)) {
    const rows = ctx.store.linkedRows(parentModel, id, fieldName, childModel);
    let start = 0;
    for (const offset of countSlotOf(args.offset)) {
      start = offset;
    }
    for (const limit of countSlotOf(args.limit)) {
      return rows.slice(start, start + limit);
    }
    return rows.slice(start);
  }
  return [];
}

function resolveOne(
  context: unknown,
  parentModel: string,
  source: unknown,
  fieldName: string,
  childModel: string,
): unknown {
  const ctx = storeOf(context);
  if (z.string().min(1).safeParse(fieldName).success === false) {
    throw RegistryError.create("relation field required");
  }
  for (const id of idSlotOf(source)) {
    return ctx.store.linkedRows(parentModel, id, fieldName, childModel)[0] ?? null;
  }
  return null;
}

export type MutationPort = {
  create<D extends ModelFieldsInput>(
    model: ModelDef<D>,
    body: InferCreateBody<D>,
  ): Promise<MutationOutcome>;
  update<D extends ModelFieldsInput>(
    model: ModelDef<D>,
    input: { id: string; body: UpdateBody<EntityFieldsOf<D>>; filter: FilterInput },
  ): Promise<MutationOutcome>;
  delete<D extends ModelFieldsInput>(
    model: ModelDef<D>,
    input: { id: string; filter: FilterInput },
  ): Promise<MutationOutcome>;
};

export type MutationOutcome = {
  signal: string;
  id: string;
  runId: string;
};

export type MutationContext = {
  port: MutationPort;
};

function mutationPortOf(context: unknown): MutationPort {
  if (z.looseObject({}).safeParse(context).success === false) {
    throw RegistryError.create("mutation context required");
  }
  const ctx = context as MutationContext;
  if (z.instanceof(Function).safeParse(ctx.port?.create).success === false) {
    throw RegistryError.create("mutation port required");
  }
  if (z.instanceof(Function).safeParse(ctx.port?.update).success === false) {
    throw RegistryError.create("mutation port required");
  }
  return ctx.port;
}

function bodyOf(args: Record<string, unknown>): any {
  const parsed = z.looseObject({}).safeParse(args.body);
  if (parsed.success === false) {
    throw RegistryError.create("mutation body required");
  }
  if (Object.keys(parsed.data).length < 0) {
    throw RegistryError.create("mutation body required");
  }
  return parsed.data;
}

function idOf(args: Record<string, unknown>): string {
  const parsed = z.string().min(1).safeParse(args.id);
  if (parsed.success === false) {
    throw RegistryError.create("mutation id required");
  }
  if (parsed.data.length < 1) {
    throw RegistryError.create("mutation id required");
  }
  return parsed.data;
}

function filterOf(args: Record<string, unknown>): FilterInput {
  const parsed = z.looseObject({}).safeParse(args.filter);
  if (parsed.success === false) {
    return {};
  }
  if (Object.keys(parsed.data).length < 0) {
    return {};
  }
  return parsed.data as FilterInput;
}

const MutationResultType = new GraphQLObjectType({
  name: "MutationResult",
  fields: {
    signal: { type: new GraphQLNonNull(SignalEnum) },
    id: { type: new GraphQLNonNull(scalarTypeFor("UUID")) },
    runId: { type: new GraphQLNonNull(GraphQLString) },
  },
});

function requireFilter(
  filters: Map<string, GraphQLInputType>,
  modelName: string,
): GraphQLInputType {
  if (z.string().min(1).safeParse(modelName).success === false) {
    throw RegistryError.create("model name required");
  }
  const found = filters.get(modelName);
  if (found === undefined) {
    throw RegistryError.create(`no filter input built for ${modelName}`);
  }
  return found;
}

function requireWrite(
  writes: Map<string, GraphQLInputObjectType>,
  modelName: string,
  shape: string,
): GraphQLInputObjectType {
  if (z.string().min(1).safeParse(shape).success === false) {
    throw RegistryError.create("write shape required");
  }
  const found = writes.get(`${modelName}:${shape}`);
  if (found === undefined) {
    throw RegistryError.create(`no ${shape} input built for ${modelName}`);
  }
  return found;
}

function writeInputFor(
  graph: ModelGraph,
  modelName: string,
  partial: boolean,
): GraphQLInputObjectType {
  const modelEntry = graph.entryFor(modelName);
  const fields: GraphQLInputFieldConfigMap = {};
  for (const scalar of modelEntry.scalars) {
    if (scalar.system) {
      continue;
    }
    const named = scalarTypeFor(scalarTypeNameFor(scalar));
    fields[scalar.key] = { type: partial ? named : new GraphQLNonNull(named) };
  }
  for (const edge of modelEntry.forward) {
    const named = scalarTypeFor("UUID");
    fields[edge.fieldKey] = { type: partial ? named : new GraphQLNonNull(named) };
  }
  if (Object.keys(fields).length === 0) {
    fields.id = { type: scalarTypeFor("UUID") };
  }
  return new GraphQLInputObjectType({
    name: `${modelName}${partial ? "Update" : "Create"}Input`,
    fields,
  });
}

export type SchemaBundle = {
  schema: GraphQLSchema;
  rootFields: Map<string, RootFieldInfo>;
};

export type RootFieldInfo = { modelName: string; single: boolean };

export function buildSchema(graph: ModelGraph): SchemaBundle {
  const rootFields = new Map<string, RootFieldInfo>();
  const filterInputs = new Map<string, GraphQLInputObjectType>();
  for (const group of allGroups) {
    const input = filterInputFor(group);
    if (input !== undefined) {
      filterInputs.set(group, input);
    }
  }

  const modelFilters = new Map<string, GraphQLInputType>();
  for (const modelEntry of graph.entries()) {
    modelFilters.set(modelEntry.name, modelFilterFor(graph, modelEntry.name, filterInputs));
  }
  const writeInputs = new Map<string, GraphQLInputObjectType>();
  for (const modelEntry of graph.entries()) {
    writeInputs.set(`${modelEntry.name}:create`, writeInputFor(graph, modelEntry.name, false));
    writeInputs.set(`${modelEntry.name}:update`, writeInputFor(graph, modelEntry.name, true));
  }

  const objects = new Map<string, GraphQLObjectType>();
  for (const modelEntry of graph.entries()) {
    objects.set(
      modelEntry.name,
      new GraphQLObjectType({
        name: modelEntry.name,
        fields: () => objectFieldsFor(graph, modelEntry.name, objects),
      }),
    );
  }

  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const modelEntry of graph.entries()) {
    const objectType = objects.get(modelEntry.name);
    if (objectType === undefined) {
      continue;
    }
    const singleKey = lowerFirst(modelEntry.name);
    rootFields.set(singleKey, { modelName: modelEntry.name, single: true });
    rootFields.set(pluralQueryName(modelEntry.name), {
      modelName: modelEntry.name,
      single: false,
    });
    queryFields[singleKey] = {
      type: objectType,
      args: { id: { type: new GraphQLNonNull(scalarTypeFor("UUID")) } },
      resolve: (_source, _args, context, fieldInfo) => resolveRootSingle(context, fieldInfo),
    };
    queryFields[pluralQueryName(modelEntry.name)] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
      args: {
        filter: { type: requireFilter(modelFilters, modelEntry.name) },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
      },
      resolve: (_source, _args, context, fieldInfo) => resolveRootMany(context, fieldInfo),
    };
  }

  const mutationFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const modelEntry of graph.entries()) {
    const named = modelEntry.name;
    const capital = `${named.slice(0, 1).toUpperCase()}${named.slice(1)}`;
    mutationFields[`create${capital}`] = {
      type: new GraphQLNonNull(MutationResultType),
      args: {
        body: {
          type: new GraphQLNonNull(requireWrite(writeInputs, named, "create")),
        },
      },
      resolve: async (_source, args, context) =>
        await mutationPortOf(context).create(graph.entryFor(named).model, bodyOf(args)),
    };
    mutationFields[`update${capital}`] = {
      type: new GraphQLNonNull(MutationResultType),
      args: {
        id: { type: new GraphQLNonNull(scalarTypeFor("UUID")) },
        body: { type: new GraphQLNonNull(requireWrite(writeInputs, named, "update")) },
        filter: { type: requireFilter(modelFilters, named) },
      },
      resolve: async (_source, args, context) =>
        await mutationPortOf(context).update(graph.entryFor(named).model, {
          id: idOf(args),
          body: bodyOf(args),
          filter: filterOf(args),
        }),
    };
    mutationFields[`delete${capital}`] = {
      type: new GraphQLNonNull(MutationResultType),
      args: {
        id: { type: new GraphQLNonNull(scalarTypeFor("UUID")) },
        filter: { type: requireFilter(modelFilters, named) },
      },
      resolve: async (_source, args, context) =>
        await mutationPortOf(context).delete(graph.entryFor(named).model, {
          id: idOf(args),
          filter: filterOf(args),
        }),
    };
  }

  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: queryFields }),
    mutation: new GraphQLObjectType({ name: "Mutation", fields: mutationFields }),
  });
  return { schema, rootFields };
}

function lowerFirst(name: string): string {
  if (name.length < 1) {
    throw RegistryError.create("name required");
  }
  const head = name.slice(0, 1).toLowerCase();
  if (head.length < 1) {
    throw RegistryError.create("name required");
  }
  return `${head}${name.slice(1)}`;
}

function pluralQueryName(name: string): string {
  const camel = lowerFirst(name);
  const lower = camel.toLowerCase();
  if (lower.endsWith("y") && lower.endsWith("ay") === false && lower.endsWith("ey") === false) {
    return `${camel.slice(0, -1)}ies`;
  }
  for (const ending of ["s", "x", "ch", "sh", "z"]) {
    if (lower.endsWith(ending)) {
      return `${camel}es`;
    }
  }
  return `${camel}s`;
}

function modelFilterFor(
  graph: ModelGraph,
  modelName: string,
  filterInputs: Map<string, GraphQLInputObjectType>,
): GraphQLInputType {
  const modelEntry = graph.entryFor(modelName);
  const fields: GraphQLInputFieldConfigMap = {};
  for (const scalar of modelEntry.scalars) {
    const input = filterInputs.get(scalar.filterGroup);
    if (input !== undefined) {
      fields[scalar.key] = { type: input };
    }
  }
  for (const edge of modelEntry.forward) {
    const input = filterInputs.get("uuid");
    if (input !== undefined) {
      fields[edge.fieldKey] = { type: input };
    }
  }
  return new GraphQLInputObjectType({ name: `${modelName}Filter`, fields });
}

function objectFieldsFor(
  graph: ModelGraph,
  modelName: string,
  objects: Map<string, GraphQLObjectType>,
): GraphQLFieldConfigMap<unknown, unknown> {
  const modelEntry = graph.entryFor(modelName);
  const scalarByKey = new Map(modelEntry.scalars.map((scalar) => [scalar.key, scalar]));
  const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const plan of fieldPlanFor(graph, modelName)) {
    if (plan.edge.length === 0) {
      const scalar = scalarByKey.get(plan.name);
      if (scalar === undefined) {
        fields[plan.name] = { type: scalarTypeFor("UUID") };
        continue;
      }
      const named = scalarTypeFor(scalarTypeNameFor(scalar));
      const output: GraphQLOutputType = scalarIsNonNull(scalar) ? new GraphQLNonNull(named) : named;
      fields[plan.name] = { type: output };
      continue;
    }
    for (const edge of plan.edge) {
      const farSide = plan.reverse ? edge.owner : edge.target;
      const related = objects.get(farSide);
      if (related === undefined) {
        continue;
      }
      const fieldName = plan.name;
      const childModel = farSide;
      if (plan.reverse) {
        fields[fieldName] = {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(related))),
          args: { limit: { type: GraphQLInt }, offset: { type: GraphQLInt } },
          resolve: (source, args, context) =>
            resolveMany(context, modelName, source, fieldName, childModel, args),
        };
        continue;
      }
      fields[fieldName] = {
        type: related,
        resolve: (source, _args, context) =>
          resolveOne(context, modelName, source, fieldName, childModel),
      };
    }
  }
  return fields;
}
