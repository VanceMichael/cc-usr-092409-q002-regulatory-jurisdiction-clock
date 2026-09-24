import { createHash, randomUUID } from "node:crypto";
import type { Context } from "../db.js";

export function newId(): string {
  return randomUUID();
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** 稳定序列化：键排序、无多余空白，保证跨进程清单哈希一致。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortValue(v)]),
    );
  }
  return value;
}

export function isoNow(ctx: Context): string {
  return ctx.now();
}
