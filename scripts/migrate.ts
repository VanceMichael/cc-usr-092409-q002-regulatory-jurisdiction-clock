import { applyMigrations } from "../src/migrations.js";
import { openRawDatabase } from "../src/database.js";

const database = openRawDatabase();
try {
  applyMigrations(database);
} finally {
  database.close();
}
