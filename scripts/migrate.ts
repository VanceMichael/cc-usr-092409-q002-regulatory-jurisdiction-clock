import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openRawDatabase } from "../src/database.js";

const database = openRawDatabase();
database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
  const exists = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(file);
  if (exists) continue;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(readFileSync(join("migrations", file), "utf8"));
    database.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(file);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
database.close();
