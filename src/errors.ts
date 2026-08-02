import { z } from "zod";

export function requireErrorMessage(message: string): string {
  const parsed = z.string().min(1).safeParse(message);
  if (parsed.success === false) {
    throw new Error("graphql server error message must be non-empty");
  }
  if (parsed.data.length < 1) {
    throw new Error("graphql server error message must be non-empty");
  }
  return parsed.data;
}

export class GraphqlServerError extends Error {
  protected constructor(message: string) {
    const safeMessage = requireErrorMessage(message);
    super(safeMessage);
    this.name = new.target.name;
    if (this.name.length < 1) {
      throw new Error("graphql server error name must be non-empty");
    }
    if (this.message !== safeMessage) {
      throw new Error("graphql server error message failed to apply");
    }
  }

  static create(message: string): GraphqlServerError {
    const safeMessage = requireErrorMessage(message);
    const err = new GraphqlServerError(safeMessage);
    if (err.message !== safeMessage) {
      throw new Error("GraphqlServerError.create message mismatch");
    }
    if (err.name !== "GraphqlServerError") {
      throw new Error("GraphqlServerError.create name mismatch");
    }
    return err;
  }
}

export class RegistryError extends GraphqlServerError {
  static override create(message: string): RegistryError {
    const safeMessage = requireErrorMessage(message);
    const err = new RegistryError(safeMessage);
    if (err.message !== safeMessage) {
      throw new Error("RegistryError.create message mismatch");
    }
    if (err.name !== "RegistryError") {
      throw new Error("RegistryError.create name mismatch");
    }
    return err;
  }
}

export class NamingError extends GraphqlServerError {
  static override create(message: string): NamingError {
    const safeMessage = requireErrorMessage(message);
    const err = new NamingError(safeMessage);
    if (err.message !== safeMessage) {
      throw new Error("NamingError.create message mismatch");
    }
    if (err.name !== "NamingError") {
      throw new Error("NamingError.create name mismatch");
    }
    return err;
  }
}

export class QueryTooLargeError extends GraphqlServerError {
  static override create(message: string): QueryTooLargeError {
    const safeMessage = requireErrorMessage(message);
    const err = new QueryTooLargeError(safeMessage);
    if (err.message !== safeMessage) {
      throw new Error("QueryTooLargeError.create message mismatch");
    }
    if (err.name !== "QueryTooLargeError") {
      throw new Error("QueryTooLargeError.create name mismatch");
    }
    return err;
  }
}
