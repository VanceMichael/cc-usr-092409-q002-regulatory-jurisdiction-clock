import Fastify, { type FastifyInstance } from "fastify";
import { getContext, type Context } from "./db.js";
import { registerRoutes } from "./routes.js";

export function buildApp(ctx: Context = getContext()): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));
  registerRoutes(app, ctx);
  return app;
}
