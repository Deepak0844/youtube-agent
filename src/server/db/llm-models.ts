import type pg from "pg";
import {
  capabilitiesSchema,
  parseStoredPrices,
  checkModelUsable,
  deriveEndpointKind,
  eligibleForStage,
  isStage,
  modelInputSchema,
  type EndpointKind,
  type ModelInput,
  type ModelRow,
  type PriceBlock,
} from "@/server/core/llm-catalog";
import { recordAudit } from "@/server/db/audit";
import { getSetting, type Actor } from "@/server/db/settings";

// Model catalog and stage routes (Doc 08 section 3-4). Everything here edits prices or routing, which are safety settings
// (Doc 02 4.6): session actor only. Every change writes one audit row in the same transaction. Audit detail carries
// ids, names and flags, never anything secret (API keys are not handled here at all).

/** Message is safe to show the owner. Anything else that escapes is reported as a generic failure by the action. */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

interface DbModel {
  id: string;
  provider: string;
  model_id: string;
  label: string;
  base_url: string | null;
  prices: PriceBlock | null;
  is_free: boolean;
  capabilities: unknown;
  endpoint_kind: EndpointKind;
  enabled: boolean;
}

const COLS = "id, provider, model_id, label, base_url, prices, is_free, capabilities, endpoint_kind, enabled";

function toRow(r: DbModel): ModelRow {
  return {
    id: r.id,
    provider: r.provider,
    modelId: r.model_id,
    label: r.label,
    baseUrl: r.base_url,
    prices: parseStoredPrices(r.prices), // a tampered block reads as "no price", never as a cheap one
    isFree: r.is_free,
    capabilities: capabilitiesSchema.parse(r.capabilities),
    enabled: r.enabled,
    endpointKind: r.endpoint_kind,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertSession(actor: Actor): void {
  if (actor !== "session") throw new CatalogError("Only a signed-in session can change models and routes.");
}
function assertId(id: string): void {
  if (!UUID.test(id)) throw new CatalogError("Unknown model.");
}

export async function localServices(db: pg.Pool | pg.PoolClient): Promise<string[]> {
  // Read-only (getSetting). This file never calls setSetting.
  const v = await getSetting(db, "network.local_services");
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function listModels(db: pg.Pool | pg.PoolClient): Promise<ModelRow[]> {
  const { rows } = await db.query<DbModel>(`select ${COLS} from llm_models order by lower(label), id`);
  return rows.map(toRow);
}

export async function getModel(db: pg.Pool | pg.PoolClient, id: string): Promise<ModelRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await db.query<DbModel>(`select ${COLS} from llm_models where id = $1`, [id]);
  return rows[0] ? toRow(rows[0]) : undefined;
}

export async function listRoutes(db: pg.Pool | pg.PoolClient): Promise<Record<string, string>> {
  const { rows } = await db.query<{ stage: string; model_id: string }>("select stage, model_id from llm_routes");
  return Object.fromEntries(rows.map((r) => [r.stage, r.model_id]));
}

export interface CatalogDefault {
  id: string;
  provider: string;
  modelId: string;
  label: string;
  baseUrl: string | null;
  isFree: boolean;
  capabilities: unknown;
  priceAsOf: string | null;
  note: string;
}
export async function listDefaults(db: pg.Pool | pg.PoolClient): Promise<CatalogDefault[]> {
  const { rows } = await db.query(
    "select id, provider, model_id, label, base_url, is_free, capabilities, to_char(price_as_of, 'YYYY-MM-DD') as price_as_of, note from model_catalog_defaults order by provider, model_id",
  );
  return rows.map((r) => ({ id: r.id, provider: r.provider, modelId: r.model_id, label: r.label, baseUrl: r.base_url, isFree: r.is_free, capabilities: r.capabilities, priceAsOf: r.price_as_of, note: r.note }));
}

async function tx<T>(db: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function parseInput(raw: unknown, local: string[]): ModelInput & { endpointKind: EndpointKind } {
  const r = modelInputSchema(local).safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    // Library wording ("expected number, received NaN") means nothing to the owner; custom rules already read well.
    if (i && i.code !== "custom") {
      if (i.path[0] === "prices") throw new CatalogError("Prices are dollars per million tokens, for example 3 or 0.075. Input and output must be above zero.");
      if (i.path[0] === "capabilities") throw new CatalogError("Context window must be a whole number of tokens.");
      if (i.path[0] === "baseUrl") throw new CatalogError("That base URL is not valid.");
      throw new CatalogError("Check the provider, model id and name.");
    }
    throw new CatalogError(i?.message ?? "Those model details are not valid.");
  }
  const kind = deriveEndpointKind(r.data.baseUrl, local);
  if (kind === "invalid") throw new CatalogError("That base URL cannot be used as a model endpoint.");
  return { ...r.data, endpointKind: kind };
}

const auditDetail = (m: { provider: string; modelId: string; label: string; enabled: boolean; isFree: boolean; endpointKind: string; prices: PriceBlock | null }) => ({
  provider: m.provider,
  model: m.modelId,
  label: m.label,
  enabled: m.enabled,
  free: m.isFree,
  endpoint: m.endpointKind,
  priced: m.prices !== null,
});

function translate(err: unknown): never {
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") throw new CatalogError("That model is already in the catalog.");
  throw err;
}

export async function createModel(db: pg.Pool, raw: unknown, opts: { actor: Actor }): Promise<ModelRow> {
  assertSession(opts.actor);
  const local = await localServices(db);
  const m = parseInput(raw, local);
  return tx(db, async (c) => {
    const { rows } = await c
      .query<DbModel>(
        `insert into llm_models (provider, model_id, label, base_url, prices, is_free, capabilities, endpoint_kind, enabled)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9) returning ${COLS}`,
        [m.provider, m.modelId, m.label, m.baseUrl, m.prices ? JSON.stringify(m.prices) : null, m.isFree, JSON.stringify(m.capabilities), m.endpointKind, m.enabled],
      )
      .catch(translate);
    await recordAudit(c, "model.added", { id: rows[0]!.id, ...auditDetail(m) });
    return toRow(rows[0]!);
  });
}

/** Routes pointing at the model must stay valid after the edit (enabled, priced, capable for their stage). */
async function assertRoutesStillValid(c: pg.PoolClient, next: ModelRow, local: string[]): Promise<void> {
  const { rows } = await c.query<{ stage: string }>("select stage from llm_routes where model_id = $1", [next.id]);
  for (const { stage } of rows) {
    const usable = checkModelUsable(next, local);
    const fit = eligibleForStage(stage, next);
    if (!usable.ok || !fit.ok) throw new CatalogError(`This model is the route for "${stage}". Change that route first.`);
  }
}

export async function updateModel(db: pg.Pool, id: string, raw: unknown, opts: { actor: Actor }): Promise<ModelRow> {
  assertSession(opts.actor);
  assertId(id);
  const local = await localServices(db);
  const m = parseInput(raw, local);
  return tx(db, async (c) => {
    const found = await c.query("select 1 from llm_models where id = $1 for update", [id]);
    if (found.rowCount === 0) throw new CatalogError("Unknown model.");
    const { rows } = await c
      .query<DbModel>(
        `update llm_models set provider=$2, model_id=$3, label=$4, base_url=$5, prices=$6::jsonb, is_free=$7, capabilities=$8::jsonb,
           endpoint_kind=$9, enabled=$10, updated_at=now() where id = $1 returning ${COLS}`,
        [id, m.provider, m.modelId, m.label, m.baseUrl, m.prices ? JSON.stringify(m.prices) : null, m.isFree, JSON.stringify(m.capabilities), m.endpointKind, m.enabled],
      )
      .catch(translate);
    const row = toRow(rows[0]!);
    await assertRoutesStillValid(c, row, local);
    await recordAudit(c, "model.changed", { id, ...auditDetail(m) });
    return row;
  });
}

export async function deleteModel(db: pg.Pool, id: string, opts: { actor: Actor }): Promise<void> {
  assertSession(opts.actor);
  assertId(id);
  await tx(db, async (c) => {
    const { rows } = await c.query<DbModel>(`select ${COLS} from llm_models where id = $1 for update`, [id]);
    if (!rows[0]) throw new CatalogError("Unknown model.");
    const used = await c.query<{ stage: string }>("select stage from llm_routes where model_id = $1", [id]);
    if (used.rowCount) throw new CatalogError(`This model is the route for "${used.rows[0]!.stage}". Change that route first.`);
    await c.query("delete from llm_models where id = $1", [id]);
    await recordAudit(c, "model.removed", { id, provider: rows[0].provider, model: rows[0].model_id, label: rows[0].label });
  });
}

/** Copies a read-only suggestion into the owner's catalog. Hosted suggestions arrive disabled and unpriced. */
export async function copyDefault(db: pg.Pool, defaultId: string, opts: { actor: Actor }): Promise<ModelRow> {
  assertSession(opts.actor);
  const { rows } = await db.query(
    "select provider, model_id, label, base_url, prices, is_free, capabilities from model_catalog_defaults where id = $1",
    [defaultId],
  );
  const d = rows[0];
  if (!d) throw new CatalogError("Unknown suggestion.");
  const local = await localServices(db);
  const copy = {
    provider: d.provider,
    modelId: d.model_id,
    label: d.label,
    baseUrl: d.base_url,
    prices: d.prices ?? null,
    isFree: d.is_free,
    capabilities: d.capabilities,
    enabled: false,
  };
  // A free suggestion only stays free where the address is local on this installation; otherwise it is copied unpriced.
  if (copy.isFree && deriveEndpointKind(copy.baseUrl, local) !== "local") copy.isFree = false;
  return createModel(db, copy, opts);
}

/** stage -> model, or null to clear. The model must be enabled, priced and capable for the stage. */
export async function setRoute(db: pg.Pool, stage: string, modelId: string | null, opts: { actor: Actor }): Promise<void> {
  assertSession(opts.actor);
  if (!isStage(stage)) throw new CatalogError("Unknown stage.");
  const local = await localServices(db);
  await tx(db, async (c) => {
    const { rows: prev } = await c.query<{ model_id: string }>("select model_id from llm_routes where stage = $1 for update", [stage]);
    if (modelId === null) {
      await c.query("delete from llm_routes where stage = $1", [stage]);
    } else {
      assertId(modelId);
      const { rows } = await c.query<DbModel>(`select ${COLS} from llm_models where id = $1 for share`, [modelId]);
      if (!rows[0]) throw new CatalogError("Unknown model.");
      const model = toRow(rows[0]);
      const usable = checkModelUsable(model, local);
      if (!usable.ok) throw new CatalogError(usable.reason);
      const fit = eligibleForStage(stage, model);
      if (!fit.ok) throw new CatalogError(`This model lacks: ${fit.missing.join(", ")}.`);
      await c.query(
        `insert into llm_routes (stage, model_id, updated_at) values ($1, $2, now())
         on conflict (stage) do update set model_id = excluded.model_id, updated_at = now()`,
        [stage, modelId],
      );
    }
    await recordAudit(c, "route.changed", { stage, from: prev[0]?.model_id ?? null, to: modelId });
  });
}

/** Models a stage may use right now (the UI offers only these). */
export function modelsForStage(stage: string, models: ModelRow[], local: string[]): { model: ModelRow; warnings: string[] }[] {
  const out: { model: ModelRow; warnings: string[] }[] = [];
  for (const model of models) {
    if (!checkModelUsable(model, local).ok) continue;
    const fit = eligibleForStage(stage, model);
    if (fit.ok) out.push({ model, warnings: fit.warnings });
  }
  return out;
}
