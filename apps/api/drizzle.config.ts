import { defineConfig } from "drizzle-kit";

// Genera SQL (dialecto sqlite) en ./migrations; se aplica con `wrangler d1 migrations apply`.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
