import { z } from "zod";
import { appendItem, filterOpsConfigForGroup } from "@fookiejs/core";
import type { FilterGroup } from "@fookiejs/core";
import type { ScalarTypeName } from "./scalars.ts";
import { RegistryError } from "../errors.ts";

export type FilterOperandKinds = {
  single: "single";
  list: "list";
  text: "text";
  near: "near";
};

export type FilterOperand = FilterOperandKinds[keyof FilterOperandKinds];

export type FilterOpField = {
  name: string;
  operand: FilterOperand;
};

const compareOps: readonly string[] = ["gt", "gte", "lt", "lte"];

const patternOps: readonly string[] = ["like", "ilike", "startsWith", "endsWith"];

export function filterOpFieldsFor(group: FilterGroup): readonly FilterOpField[] {
  if (z.string().min(1).safeParse(group).success === false) {
    throw RegistryError.create("filter group required");
  }
  const config = filterOpsConfigForGroup(group);
  let fields: readonly FilterOpField[] = [
    { name: "eq", operand: "single" },
    { name: "ne", operand: "single" },
  ];
  if (config.compare) {
    for (const op of compareOps) {
      fields = appendItem(fields, { name: op, operand: "single" });
    }
  }
  if (config.stringPattern) {
    for (const op of patternOps) {
      fields = appendItem(fields, { name: op, operand: "text" });
    }
  }
  if (config.inList) {
    fields = appendItem(fields, { name: "in", operand: "list" });
  }
  if (config.contains) {
    fields = appendItem(fields, { name: "contains", operand: "text" });
  }
  if (config.near) {
    fields = appendItem(fields, { name: "near", operand: "near" });
  }
  return fields;
}

export function filterInputNameFor(group: FilterGroup): string {
  if (z.string().min(1).safeParse(group).success === false) {
    throw RegistryError.create("filter group required");
  }
  const head = group.slice(0, 1).toUpperCase();
  const tail = group.slice(1);
  if (head.length < 1) {
    throw RegistryError.create("filter group required");
  }
  return `${head}${tail}Filter`;
}

export type FilterInputPlan = {
  name: string;
  group: FilterGroup;
  scalar: ScalarTypeName;
  fields: readonly FilterOpField[];
};

export function filterInputPlanFor(group: FilterGroup, scalar: ScalarTypeName): FilterInputPlan {
  if (z.string().min(1).safeParse(scalar).success === false) {
    throw RegistryError.create("filter scalar required");
  }
  const fields = filterOpFieldsFor(group);
  if (fields.length < 1) {
    throw RegistryError.create("filter group produced no operators");
  }
  const name = filterInputNameFor(group);
  return { name, group, scalar, fields };
}
