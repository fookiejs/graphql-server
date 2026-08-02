import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLScalarType,
  GraphQLString,
} from "graphql";
import type { GraphQLScalarType as ScalarTypeShape } from "graphql";
import type { ScalarTypeName } from "../schema/scalars.ts";

export const UUIDScalar = new GraphQLScalarType({
  name: "UUID",
  description: "A UUID, serialised as a string.",
  serialize: (scalarValue) => String(scalarValue),
  parseValue: (scalarValue) => String(scalarValue),
});

export const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "An ISO-8601 timestamp, serialised as a string.",
  serialize: (scalarValue) => String(scalarValue),
  parseValue: (scalarValue) => String(scalarValue),
});

export const DecimalScalar = new GraphQLScalarType({
  name: "Decimal",
  description: "An exact numeric value carried as a string so precision is never lost.",
  serialize: (scalarValue) => String(scalarValue),
  parseValue: (scalarValue) => String(scalarValue),
});

export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "An arbitrary JSON document carried as a string.",
  serialize: (scalarValue) => String(scalarValue),
  parseValue: (scalarValue) => String(scalarValue),
});

export const CoordinateScalar = new GraphQLScalarType({
  name: "Coordinate",
  description: "A point, serialised as a two-element [x, y] array.",
  serialize: (scalarValue) => scalarValue,
  parseValue: (scalarValue) => scalarValue,
});

export function scalarTypeFor(name: ScalarTypeName): ScalarTypeShape {
  if (name === "Int") {
    return GraphQLInt;
  }
  if (name === "Float") {
    return GraphQLFloat;
  }
  if (name === "Boolean") {
    return GraphQLBoolean;
  }
  if (name === "UUID") {
    return UUIDScalar;
  }
  if (name === "DateTime") {
    return DateTimeScalar;
  }
  if (name === "Decimal") {
    return DecimalScalar;
  }
  if (name === "JSON") {
    return JSONScalar;
  }
  if (name === "Coordinate") {
    return CoordinateScalar;
  }
  return GraphQLString;
}
