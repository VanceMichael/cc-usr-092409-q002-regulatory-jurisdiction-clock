import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

interface DatabaseSchema {
  service_state: {
    key: string;
    value: string;
    updated_at: string;
  };
}

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? "data/consumer_disputes.sqlite3";
}

export function openRawDatabase(): Database.Database {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  return database;
}

export function openDatabase(): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: openRawDatabase() }),
  });
}
