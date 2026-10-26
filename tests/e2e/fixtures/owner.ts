import path from "node:path";

// The one fixed owner every e2e run is seeded with (global-setup.ts). Test-only credentials; the database is a throwaway
// Testcontainers instance.
export const OWNER_USERNAME = "owner";
export const OWNER_PASSWORD = "correct-horse-battery-staple-7!";
export const STORAGE_STATE = path.resolve("test-results/owner-storage-state.json");
// Seeding and session minting use their own ip so they never touch the ips the specs use.
export const SEED_IP = "198.51.100.1";
