import { Kind, getOperationAST, valueFromASTUntyped } from "graphql";
import type { DocumentNode, FieldNode, FragmentDefinitionNode, SelectionSetNode } from "graphql";
import { z } from "zod";
import { appendItem } from "@fookiejs/core";
import type { FilterInput } from "@fookiejs/core";
import { fieldPlanFor } from "../naming.ts";
import type { ModelGraph } from "../registry.ts";
import type { Selection } from "../plan/prefetch.ts";
import { RegistryError } from "../errors.ts";

export type RootRequest = {
  responseKey: string;
  fieldName: string;
  modelName: string;
  single: boolean;
  filter: FilterInput;
  limit: readonly number[];
  offset: readonly number[];
  selections: readonly Selection[];
};

function fragmentsOf(queryDocument: DocumentNode): Map<string, FragmentDefinitionNode> {
  const found = new Map<string, FragmentDefinitionNode>();
  for (const definition of queryDocument.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      found.set(definition.name.value, definition);
    }
  }
  return found;
}

function skipped(field: FieldNode, variables: Record<string, unknown>): boolean {
  for (const directive of field.directives ?? []) {
    const name = directive.name.value;
    if (name !== "skip" && name !== "include") {
      continue;
    }
    for (const argument of directive.arguments ?? []) {
      if (argument.name.value !== "if") {
        continue;
      }
      const flag = valueFromASTUntyped(argument.value, variables);
      if (name === "skip" && flag === true) {
        return true;
      }
      if (name === "include" && flag === false) {
        return true;
      }
    }
  }
  return false;
}

function fieldsOf(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  variables: Record<string, unknown>,
): readonly FieldNode[] {
  let fields: readonly FieldNode[] = [];
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (skipped(selection, variables) === false) {
        fields = appendItem(fields, selection);
      }
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      for (const nested of fieldsOf(selection.selectionSet, fragments, variables)) {
        fields = appendItem(fields, nested);
      }
      continue;
    }
    const spread = fragments.get(selection.name.value);
    if (spread === undefined) {
      throw RegistryError.create(`unknown fragment ${selection.name.value}`);
    }
    for (const nested of fieldsOf(spread.selectionSet, fragments, variables)) {
      fields = appendItem(fields, nested);
    }
  }
  return fields;
}

function relationSelectionsOf(
  graph: ModelGraph,
  modelName: string,
  selectionSet: SelectionSetNode | undefined,
  fragments: Map<string, FragmentDefinitionNode>,
  variables: Record<string, unknown>,
): readonly Selection[] {
  if (selectionSet === undefined) {
    return [];
  }
  const plans = fieldPlanFor(graph, modelName);
  let selections: readonly Selection[] = [];
  for (const field of fieldsOf(selectionSet, fragments, variables)) {
    for (const plan of plans) {
      if (plan.name !== field.name.value) {
        continue;
      }
      for (const edge of plan.edge) {
        const childModel = plan.reverse ? edge.owner : edge.target;
        selections = appendItem(selections, {
          field: plan.name,
          children: relationSelectionsOf(
            graph,
            childModel,
            field.selectionSet,
            fragments,
            variables,
          ),
        });
      }
    }
  }
  return selections;
}

function argumentsOf(
  field: FieldNode,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  if (z.looseObject({}).safeParse(variables).success === false) {
    throw RegistryError.create("variables must be an object");
  }
  const bag: Record<string, unknown> = {};
  for (const argument of field.arguments ?? []) {
    bag[argument.name.value] = valueFromASTUntyped(argument.value, variables);
  }
  return bag;
}

function numberSlot(candidate: unknown): readonly number[] {
  const parsed = z.number().int().nonnegative().safeParse(candidate);
  if (parsed.success === false) {
    return [];
  }
  if (Number.isInteger(parsed.data) === false) {
    return [];
  }
  return [parsed.data];
}

export function collectRoots(
  graph: ModelGraph,
  queryDocument: DocumentNode,
  operationName: string | undefined,
  variables: Record<string, unknown>,
  rootFieldIndex: Map<string, { modelName: string; single: boolean }>,
): readonly RootRequest[] {
  const operation = getOperationAST(queryDocument, operationName ?? null);
  if (operation === null || operation === undefined) {
    throw RegistryError.create("no executable operation in the queryDocument");
  }
  const fragments = fragmentsOf(queryDocument);
  let roots: readonly RootRequest[] = [];
  for (const field of fieldsOf(operation.selectionSet, fragments, variables)) {
    const known = rootFieldIndex.get(field.name.value);
    if (known === undefined) {
      continue;
    }
    const args = argumentsOf(field, variables);
    const filter: FilterInput = known.single
      ? ({ id: { eq: args.id } } as FilterInput)
      : ((args.filter ?? {}) as FilterInput);
    roots = appendItem(roots, {
      responseKey: field.alias?.value ?? field.name.value,
      fieldName: field.name.value,
      modelName: known.modelName,
      single: known.single,
      filter,
      limit: numberSlot(args.limit),
      offset: numberSlot(args.offset),
      selections: relationSelectionsOf(
        graph,
        known.modelName,
        field.selectionSet,
        fragments,
        variables,
      ),
    });
  }
  return roots;
}
