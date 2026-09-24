import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

export const MIGRATIONS_DIR = "migrations";

/** 按文件名顺序应用 migrations 目录下尚未执行的 SQL，可重复调用。 */
export function applyMigrations(database: Database.Database, migrationsDir: string = MIGRATIONS_DIR): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const exists = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(file);
    if (exists) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(readFileSync(join(migrationsDir, file), "utf8"));
      database.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(file);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
