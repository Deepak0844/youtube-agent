import { getPool } from "@/server/db/pool";
async function main() {
  const db = getPool();
  const st = (await db.query("select name, status, left(coalesce(result::text,''), 160) as result from stage_runs where video_id = $1 order by created_at", ["985be907-44aa-4a16-9230-c6f303155fb2"])).rows;
  console.log(st.map((r) => `${r.name}:${r.status}${r.status === "failed" ? `(${r.result})` : ""}`).join(" "));
  await db.end();
}
void main();
