import { z } from "zod";
import type { ScalarField } from "../registry.ts";
import { RegistryError } from "../errors.ts";

export type ScalarTypeNameKinds = {
  int: "Int";
  float: "Float";
  boolean: "Boolean";
  string: "String";
  uuid: "UUID";
  dateTime: "DateTime";
  decimal: "Decimal";
  json: "JSON";
  coordinate: "Coordinate";
};

export type ScalarTypeName = ScalarTypeNameKinds[keyof ScalarTypeNameKinds];

const integerKinds: readonly string[] = ["smallint", "integer", "int", "serial"];

export function scalarTypeNameFor(field: ScalarField): ScalarTypeName {
  if (z.string().min(1).safeParse(field.filterGroup).success === false) {
    throw RegistryError.create("field filter group required");
  }
  if (field.filterGroup === "numeric") {
    if (integerKinds.includes(field.kind)) {
      return "Int";
    }
    return "Float";
  }
  if (field.filterGroup === "boolean") {
    return "Boolean";
  }
  if (field.filterGroup === "uuid") {
    return "UUID";
  }
  if (field.filterGroup === "temporal") {
    return "DateTime";
  }
  if (field.filterGroup === "bigint" || field.filterGroup === "decimal") {
    return "Decimal";
  }
  if (field.filterGroup === "json") {
    return "JSON";
  }
  if (field.filterGroup === "coordinate") {
    return "Coordinate";
  }
  return "String";
}

const alwaysPresentKeys: readonly string[] = ["id", "createdAt", "updatedAt", "isDeleted"];

export function scalarIsNonNull(field: ScalarField): boolean {
  if (z.string().min(1).safeParse(field.key).success === false) {
    throw RegistryError.create("field key required");
  }
  if (field.system === false) {
    return false;
  }
  return alwaysPresentKeys.includes(field.key);
}
