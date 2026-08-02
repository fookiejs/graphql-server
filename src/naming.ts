import { z } from "zod";
import { appendItem } from "@fookiejs/core";
import type { ForwardEdge, ModelGraph } from "./registry.ts";
import { NamingError } from "./errors.ts";

export function camelOf(name: string): string {
  if (z.string().min(1).safeParse(name).success === false) {
    throw NamingError.create("name required");
  }
  const head = name.slice(0, 1).toLowerCase();
  const tail = name.slice(1);
  if (head.length < 1) {
    throw NamingError.create("name required");
  }
  return `${head}${tail}`;
}

export function pluralOf(name: string): string {
  if (z.string().min(1).safeParse(name).success === false) {
    throw NamingError.create("name required");
  }
  const lower = name.toLowerCase();
  if (lower.endsWith("y") && lower.endsWith("ay") === false && lower.endsWith("ey") === false) {
    return `${name.slice(0, -1)}ies`;
  }
  for (const ending of ["s", "x", "ch", "sh", "z"]) {
    if (lower.endsWith(ending)) {
      return `${name}es`;
    }
  }
  return `${name}s`;
}

export function objectFieldNameFor(edge: ForwardEdge): string {
  if (z.string().min(1).safeParse(edge.fieldKey).success === false) {
    throw NamingError.create("relation field key required");
  }
  if (edge.fieldKey.endsWith("Id") && edge.fieldKey.length > 2) {
    return edge.fieldKey.slice(0, -2);
  }
  return edge.fieldKey;
}

export function reverseFieldNameFor(edge: ForwardEdge, siblings: readonly ForwardEdge[]): string {
  if (Array.isArray(siblings) === false) {
    throw NamingError.create("sibling edges required");
  }
  let sameOwner = 0;
  for (const sibling of siblings) {
    if (sibling.owner === edge.owner) {
      sameOwner += 1;
    }
  }
  const base = pluralOf(camelOf(edge.owner));
  if (sameOwner < 2) {
    return base;
  }
  const suffix = objectFieldNameFor(edge);
  const head = suffix.slice(0, 1).toUpperCase();
  return `${base}By${head}${suffix.slice(1)}`;
}

export type FieldPlan = {
  name: string;
  edge: readonly ForwardEdge[];
  reverse: boolean;
};

function assertUnused(taken: readonly string[], name: string, owner: string): void {
  if (z.string().min(1).safeParse(name).success === false) {
    throw NamingError.create("generated field name required");
  }
  if (Array.isArray(taken) === false) {
    throw NamingError.create("taken names required");
  }
  if (taken.includes(name) === false) {
    return;
  }
  throw NamingError.create(
    `${owner}.${name} collides with another generated field; rename the model field or override the relation name`,
  );
}

export function fieldPlanFor(graph: ModelGraph, modelName: string): readonly FieldPlan[] {
  const modelEntry = graph.entryFor(modelName);
  let taken: readonly string[] = [];
  let plans: readonly FieldPlan[] = [];
  for (const scalar of modelEntry.scalars) {
    taken = appendItem(taken, scalar.key);
    plans = appendItem(plans, { name: scalar.key, edge: [], reverse: false });
  }
  for (const edge of modelEntry.forward) {
    const objectName = objectFieldNameFor(edge);
    if (objectName !== edge.fieldKey) {
      assertUnused(taken, edge.fieldKey, modelName);
      taken = appendItem(taken, edge.fieldKey);
      plans = appendItem(plans, { name: edge.fieldKey, edge: [], reverse: false });
    }
    assertUnused(taken, objectName, modelName);
    taken = appendItem(taken, objectName);
    plans = appendItem(plans, { name: objectName, edge: [edge], reverse: false });
  }
  const incoming = graph.reverseOf(modelName);
  for (const edge of incoming) {
    const reverseName = reverseFieldNameFor(edge, incoming);
    assertUnused(taken, reverseName, modelName);
    taken = appendItem(taken, reverseName);
    plans = appendItem(plans, { name: reverseName, edge: [edge], reverse: true });
  }
  return plans;
}
