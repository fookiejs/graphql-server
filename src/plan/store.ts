import { z } from "zod";
import { appendItem, mapLookup } from "@fookiejs/core";
import type { EntityRecord } from "@fookiejs/core";
import { RegistryError } from "../errors.ts";

export function entityKeyOf(modelName: string, id: string): string {
  if (z.string().min(1).safeParse(modelName).success === false) {
    throw RegistryError.create("entity key model required");
  }
  if (z.string().min(1).safeParse(id).success === false) {
    throw RegistryError.create("entity key id required");
  }
  const key = `${modelName}:${id}`;
  if (key.length < 3) {
    throw RegistryError.create("entity key required");
  }
  return key;
}

export function edgeKeyOf(modelName: string, id: string, fieldName: string): string {
  if (z.string().min(1).safeParse(fieldName).success === false) {
    throw RegistryError.create("edge key field required");
  }
  const owner = entityKeyOf(modelName, id);
  const key = `${owner}#${fieldName}`;
  if (key.length <= owner.length) {
    throw RegistryError.create("edge key required");
  }
  return key;
}

export function entityIdOf(row: EntityRecord): readonly string[] {
  if (z.looseObject({}).safeParse(row).success === false) {
    return [];
  }
  const parsed = z.string().min(1).safeParse(row.id);
  if (parsed.success === false) {
    return [];
  }
  return [parsed.data];
}

export function relationValueOf(row: EntityRecord, fieldKey: string): readonly string[] {
  if (z.string().min(1).safeParse(fieldKey).success === false) {
    return [];
  }
  const parsed = z.string().min(1).safeParse(row[fieldKey]);
  if (parsed.success === false) {
    return [];
  }
  return [parsed.data];
}

export class PrefetchStore {
  private readonly entities = new Map<string, EntityRecord>();
  private readonly edges = new Map<string, readonly string[]>();

  remember(modelName: string, row: EntityRecord): boolean {
    if (z.string().min(1).safeParse(modelName).success === false) {
      throw RegistryError.create("model name required");
    }
    for (const id of entityIdOf(row)) {
      this.entities.set(entityKeyOf(modelName, id), row);
      return true;
    }
    return false;
  }

  knows(modelName: string, id: string): boolean {
    if (z.string().min(1).safeParse(id).success === false) {
      return false;
    }
    const key = entityKeyOf(modelName, id);
    if (key.length < 1) {
      return false;
    }
    return this.entities.has(key);
  }

  entityAt(modelName: string, id: string): readonly EntityRecord[] {
    if (z.string().min(1).safeParse(id).success === false) {
      return [];
    }
    for (const found of mapLookup(this.entities, entityKeyOf(modelName, id))) {
      return [found];
    }
    return [];
  }

  linkOne(modelName: string, id: string, fieldName: string, childId: readonly string[]): boolean {
    if (Array.isArray(childId) === false) {
      throw RegistryError.create("edge child id required");
    }
    if (childId.length > 1) {
      throw RegistryError.create("a forward edge holds at most one child");
    }
    this.edges.set(edgeKeyOf(modelName, id, fieldName), childId);
    return true;
  }

  linkMany(modelName: string, id: string, fieldName: string, childIds: readonly string[]): boolean {
    if (Array.isArray(childIds) === false) {
      throw RegistryError.create("edge child ids required");
    }
    if (z.string().min(1).safeParse(fieldName).success === false) {
      throw RegistryError.create("edge field required");
    }
    this.edges.set(edgeKeyOf(modelName, id, fieldName), childIds);
    return true;
  }

  linkedIds(modelName: string, id: string, fieldName: string): readonly string[] {
    if (z.string().min(1).safeParse(id).success === false) {
      return [];
    }
    for (const found of mapLookup(this.edges, edgeKeyOf(modelName, id, fieldName))) {
      return found;
    }
    return [];
  }

  linkedRows(
    modelName: string,
    id: string,
    fieldName: string,
    childModel: string,
  ): readonly EntityRecord[] {
    let rows: readonly EntityRecord[] = [];
    for (const childId of this.linkedIds(modelName, id, fieldName)) {
      for (const row of this.entityAt(childModel, childId)) {
        rows = appendItem(rows, row);
      }
    }
    return rows;
  }

  size(): number {
    const total = this.entities.size;
    if (Number.isInteger(total) === false) {
      throw RegistryError.create("store size corrupted");
    }
    if (total < 0) {
      throw RegistryError.create("store size corrupted");
    }
    return total;
  }
}
