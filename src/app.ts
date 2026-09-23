import Fastify from "fastify";
import { sql } from "kysely";
import { openDatabase } from "./database.js";

export function buildApp() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => {
    const database = openDatabase();
    await sql`SELECT 1`.execute(database);
    await database.destroy();
    return { status: "ok" };
  });
  return app;
}
