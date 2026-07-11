import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/** Cliente Drizzle sobre el binding D1 del Worker. */
export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export { schema };
