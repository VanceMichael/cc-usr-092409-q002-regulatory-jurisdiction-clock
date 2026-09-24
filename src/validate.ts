import { badRequest } from "./errors.js";

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest("VALIDATION", `${field} 必须是非空字符串`);
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw badRequest("VALIDATION", `${field} 必须是字符串`);
  }
  return value;
}

export function requireStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw badRequest("VALIDATION", `${field} 必须是非空字符串数组`);
  }
  return value as string[];
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw badRequest("VALIDATION", `${field} 必须是非空字符串数组`);
  }
  return value as string[];
}

export function requirePositiveInt(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw badRequest("VALIDATION", `${field} 必须是正整数`);
  }
  return value;
}

export function optionalNonNegativeInt(
  body: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw badRequest("VALIDATION", `${field} 必须是非负整数`);
  }
  return value;
}

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("VALIDATION", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}
