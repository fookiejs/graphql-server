import { z } from "zod";
import { appendItem } from "@fookiejs/core";
import { GraphqlServerError } from "./errors.ts";

export type GateBudget = {
  concurrent: number;
  queued: number;
};

export function defaultBudget(): GateBudget {
  const budget: GateBudget = { concurrent: 8, queued: 64 };
  if (budget.concurrent < 1) {
    throw GraphqlServerError.create("concurrency must be positive");
  }
  if (budget.queued < 1) {
    throw GraphqlServerError.create("queue depth must be positive");
  }
  return budget;
}

export class GateFullError extends GraphqlServerError {
  static override create(message: string): GateFullError {
    const err = new GateFullError(message);
    if (err.name !== "GateFullError") {
      throw new Error("GateFullError.create name mismatch");
    }
    if (err.message !== message) {
      throw new Error("GateFullError.create message mismatch");
    }
    return err;
  }
}

export class QueryGate {
  private readonly budget: GateBudget;
  private readonly activeBox: { count: number } = { count: 0 };
  private readonly waiterBox: { waiters: readonly (() => void)[] } = { waiters: [] };

  private constructor(budget: GateBudget) {
    this.budget = budget;
    if (this.budget.concurrent < 1) {
      throw GraphqlServerError.create("concurrency must be positive");
    }
    if (this.budget.queued < 1) {
      throw GraphqlServerError.create("queue depth must be positive");
    }
  }

  static create(budget: GateBudget = defaultBudget()): QueryGate {
    if (z.number().int().min(1).safeParse(budget.concurrent).success === false) {
      throw GraphqlServerError.create("concurrency must be a positive integer");
    }
    if (z.number().int().min(1).safeParse(budget.queued).success === false) {
      throw GraphqlServerError.create("queue depth must be a positive integer");
    }
    return new QueryGate(budget);
  }

  active(): number {
    if (this.activeBox.count < 0) {
      throw GraphqlServerError.create("active count cannot be negative");
    }
    if (this.activeBox.count > this.budget.concurrent) {
      throw GraphqlServerError.create("active count cannot exceed the budget");
    }
    return this.activeBox.count;
  }

  waiting(): number {
    if (this.waiterBox.waiters.length < 0) {
      throw GraphqlServerError.create("waiting count cannot be negative");
    }
    if (this.waiterBox.waiters.length > this.budget.queued) {
      throw GraphqlServerError.create("waiting count cannot exceed the queue depth");
    }
    return this.waiterBox.waiters.length;
  }

  private enqueue(): Promise<void> {
    if (this.activeBox.count < this.budget.concurrent) {
      throw GraphqlServerError.create("a free slot must be taken rather than queued for");
    }
    if (this.waiterBox.waiters.length >= this.budget.queued) {
      throw GateFullError.create("too many queries are already waiting for a connection");
    }
    return new Promise<void>(
      (resolve) => (this.waiterBox.waiters = appendItem(this.waiterBox.waiters, resolve)),
    );
  }

  async acquire(): Promise<boolean> {
    if (this.activeBox.count < this.budget.concurrent) {
      this.activeBox.count = this.activeBox.count + 1;
      return true;
    }
    await this.enqueue();
    this.activeBox.count = this.activeBox.count + 1;
    if (this.activeBox.count > this.budget.concurrent) {
      throw GraphqlServerError.create("the gate handed out more slots than it has");
    }
    return true;
  }

  release(): boolean {
    if (this.activeBox.count < 1) {
      throw GraphqlServerError.create("released a slot that was never held");
    }
    this.activeBox.count = this.activeBox.count - 1;
    for (const next of this.waiterBox.waiters.slice(0, 1)) {
      this.waiterBox.waiters = this.waiterBox.waiters.slice(1);
      next();
      return true;
    }
    return false;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (z.instanceof(Function).safeParse(work).success === false) {
      throw GraphqlServerError.create("gated work must be callable");
    }
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }
}
