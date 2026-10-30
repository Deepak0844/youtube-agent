import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { createJobCheckers } from "@/server/providers/image/wire";

/** The providers whose parked jobs the owner can check from the queue (read-only towards the provider). */
export const jobCheckers = () => createJobCheckers(getPool(), () => loadKeyring());
