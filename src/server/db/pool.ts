import pg from "pg";

// bigint columns (fence, micro-USD) arrive as strings from pg; callers convert explicitly.
export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}
