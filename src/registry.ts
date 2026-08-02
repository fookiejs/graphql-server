import { z } from "zod";
import { appendItem, isSystemFieldKey, relationTargetOf } from "@fookiejs/core";
import type { FieldValue, ModelDef, ModelFieldsInput } from "@fookiejs/core";
import { RegistryError } from "./errors.ts";

export type RegisteredModelDef = ModelDef<ModelFieldsInput>;

export type ForwardEdge = {
  owner: string;
  fieldKey: string;
  target: string;
};

export type ScalarField = {
  key: string;
  kind: string;
  filterGroup: string;
  system: boolean;
};

export type ModelEntry = {
  name: string;
  model: RegisteredModelDef;
  scalars: readonly ScalarField[];
  forward: readonly ForwardEdge[];
};

function scalarFieldOf(key: string, fieldValue: FieldValue): readonly ScalarField[] {
  if (relationTargetOf(fieldValue).length > 0) {
    return [];
  }
  if ("kind" in fieldValue === false) {
    return [];
  }
  if ("filterGroup" in fieldValue === false) {
    return [];
  }
  return [
    {
      key,
      kind: fieldValue.kind,
      filterGroup: fieldValue.filterGroup,
      system: isSystemFieldKey(key),
    },
  ];
}

function entryOf(model: RegisteredModelDef): ModelEntry {
  if (z.string().min(1).safeParse(model.name).success === false) {
    throw RegistryError.create("model name required");
  }
  let scalars: readonly ScalarField[] = [];
  let forward: readonly ForwardEdge[] = [];
  for (const [key, fieldValue] of Object.entries(model.fields)) {
    for (const scalar of scalarFieldOf(key, fieldValue)) {
      scalars = appendItem(scalars, scalar);
    }
    for (const target of relationTargetOf(fieldValue)) {
      forward = appendItem(forward, { owner: model.name, fieldKey: key, target });
    }
  }
  return { name: model.name, model, scalars, forward };
}

function modelNames(entries: readonly ModelEntry[]): readonly string[] {
  if (Array.isArray(entries) === false) {
    throw RegistryError.create("model entries required");
  }
  let names: readonly string[] = [];
  for (const modelEntry of entries) {
    names = appendItem(names, modelEntry.name);
  }
  return names;
}

export class ModelGraph {
  private readonly modelEntries: readonly ModelEntry[];

  private constructor(modelEntries: readonly ModelEntry[]) {
    if (modelEntries.length < 1) {
      throw RegistryError.create("at least one model is required");
    }
    if (Array.isArray(modelEntries) === false) {
      throw RegistryError.create("model entries required");
    }
    this.modelEntries = modelEntries;
  }

  static create(models: readonly RegisteredModelDef[]): ModelGraph {
    if (models.length < 1) {
      throw RegistryError.create("at least one model is required");
    }
    let built: readonly ModelEntry[] = [];
    for (const model of models) {
      if (modelNames(built).includes(model.name)) {
        throw RegistryError.create(`model ${model.name} is registered twice`);
      }
      built = appendItem(built, entryOf(model));
    }
    const known = modelNames(built);
    for (const modelEntry of built) {
      for (const edge of modelEntry.forward) {
        if (known.includes(edge.target) === false) {
          throw RegistryError.create(
            `${edge.owner}.${edge.fieldKey} points at unregistered model ${edge.target}`,
          );
        }
      }
    }
    return new ModelGraph(built);
  }

  entries(): readonly ModelEntry[] {
    if (Array.isArray(this.modelEntries) === false) {
      throw RegistryError.create("model entries required");
    }
    if (this.modelEntries.length < 1) {
      throw RegistryError.create("model entries required");
    }
    return this.modelEntries;
  }

  entryFor(name: string): ModelEntry {
    if (z.string().min(1).safeParse(name).success === false) {
      throw RegistryError.create("model name required");
    }
    for (const modelEntry of this.modelEntries) {
      if (modelEntry.name === name) {
        return modelEntry;
      }
    }
    throw RegistryError.create(`model ${name} is not registered`);
  }

  reverseOf(name: string): readonly ForwardEdge[] {
    if (modelNames(this.modelEntries).includes(name) === false) {
      throw RegistryError.create(`model ${name} is not registered`);
    }
    let incoming: readonly ForwardEdge[] = [];
    for (const modelEntry of this.modelEntries) {
      for (const edge of modelEntry.forward) {
        if (edge.target === name) {
          incoming = appendItem(incoming, edge);
        }
      }
    }
    return incoming;
  }
}
