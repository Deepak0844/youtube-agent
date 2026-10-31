import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { withTestDb, type TestDb } from "../support/db";
import { CatalogError, copyDefault, createModel, deleteModel, listDefaults, listRoutes, listModels, modelsForStage, setRoute, updateModel } from "@/server/db/llm-models";
import { setSetting } from "@/server/db/settings";
import { priceCardFor, parseStoredPrices } from "@/server/core/llm-catalog";
import { UnpricedCallError, worstCaseMicroUsd } from "@/server/core/spend";

let db: TestDb;
const session = { actor: "session" } as const;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.ownerPool.query("truncate llm_routes, llm_models, audit_log, settings restart identity cascade");
  await db.ownerPool.query(await readFile("src/server/db/migrations/0005_settings.sql", "utf8"));
});

const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const paid = { provider: "anthropic", modelId: "m-1", label: "Paid one", baseUrl: null, prices: { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 15_000_000 }, isFree: false, capabilities: caps, enabled: true };
const freeLocal = { provider: "ollama", modelId: "q-7b", label: "Local seven", baseUrl: "http://localhost:11434/v1", prices: null, isFree: true, capabilities: { ...caps, toolUse: false }, enabled: true };
const audit = async () => (await db.ownerPool.query("select event, detail from audit_log order by id")).rows;
const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(CatalogError);

describe("catalog on the app role", () => {
  it("runs_as_the_app_role_and_creates_reads_updates_deletes", async () => {
    expect((await db.pool.query("select current_user u")).rows[0].u).toBe("ytstudio_app");
    const m = await createModel(db.pool, paid, session);
    expect(m.endpointKind).toBe("hosted");
    expect((await listModels(db.pool)).map((x) => x.label)).toEqual(["Paid one"]);
    const u = await updateModel(db.pool, m.id, { ...paid, label: "Renamed" }, session);
    expect(u.label).toBe("Renamed");
    await deleteModel(db.pool, m.id, session);
    expect(await listModels(db.pool)).toEqual([]);
    expect((await audit()).map((a) => a.event)).toEqual(["model.added", "model.changed", "model.removed"]);
  });

  it("only_a_session_may_write", async () => {
    for (const actor of ["token", "system"] as const) {
      await refused(createModel(db.pool, paid, { actor }));
      await refused(setRoute(db.pool, "outline", null, { actor }));
    }
    expect(await listModels(db.pool)).toEqual([]);
  });

  it("refuses_enabling_an_unpriced_model_but_saves_it_disabled", async () => {
    await refused(createModel(db.pool, { ...paid, prices: null }, session));
    const m = await createModel(db.pool, { ...paid, prices: null, enabled: false }, session);
    await refused(updateModel(db.pool, m.id, { ...paid, prices: null, enabled: true }, session));
    const ok = await updateModel(db.pool, m.id, { ...paid, enabled: true }, session);
    expect(ok.enabled).toBe(true);
  });

  it("a_hosted_model_can_never_be_free_and_endpoint_kind_cannot_be_typed", async () => {
    await refused(createModel(db.pool, { ...paid, prices: null, isFree: true }, session));
    await refused(createModel(db.pool, { ...paid, endpointKind: "local" }, session));
    await refused(createModel(db.pool, { ...freeLocal, baseUrl: "https://api.x.test/v1" }, session));
  });

  it("the_database_itself_rejects_unpriced_enabled_and_hosted_free_rows_even_for_the_app_role", async () => {
    const ins = (kind: string, free: boolean, prices: string | null, enabled: boolean) =>
      db.pool.query(
        "insert into llm_models (provider, model_id, label, prices, is_free, capabilities, endpoint_kind, enabled) values ('x', $1, 'x', $2::jsonb, $3, '{}', $4, $5)",
        [`id-${Math.random()}`, prices, free, kind, enabled],
      );
    await expect(ins("hosted", false, null, true)).rejects.toMatchObject({ code: "23514" });
    await expect(ins("hosted", true, null, true)).rejects.toMatchObject({ code: "23514" });
    await expect(ins("local", true, '{"inputPerMTokMicro":1}', true)).rejects.toMatchObject({ code: "23514" });
  });

  it("free_local_is_allowed_and_costs_nothing_but_a_private_address_needs_the_allow_list", async () => {
    const m = await createModel(db.pool, freeLocal, session);
    expect(m.endpointKind).toBe("local");
    const lan = { ...freeLocal, modelId: "lan", baseUrl: "http://192.168.1.20:11434/v1" };
    await refused(createModel(db.pool, lan, session));
    await setSetting(db.pool, "network.local_services", ["192.168.1.20:11434"], session);
    const l = await createModel(db.pool, lan, session);
    expect(l.endpointKind).toBe("local");
    // Removing the address from the allow-list makes the free model unpriced again (re-derived at use).
    await setSetting(db.pool, "network.local_services", [], session);
    expect(priceCardFor(l, [])).toBeUndefined();
    expect(() => worstCaseMicroUsd(priceCardFor(l, []), { inputTokens: 1, maxOutputTokens: 1 })).toThrow(UnpricedCallError);
  });

  it("a_base_url_on_an_own_service_port_is_refused_even_if_listed_and_a_stored_one_is_unpriced", async () => {
    for (const url of ["http://localhost:5432/v1", "http://127.0.0.1:6379", "http://[::1]:8888", "http://localhost:3000/v1"]) {
      await refused(createModel(db.pool, { ...freeLocal, modelId: "own", baseUrl: url }, session));
    }
    // a hand-written allow-list row naming an own port changes nothing
    await db.ownerPool.query(
      `insert into settings (key, value, updated_by) values ('network.local_services', '["192.168.1.20:5432","localhost:6379"]'::jsonb, 'system')
       on conflict (key) do update set value = excluded.value`,
    );
    await refused(createModel(db.pool, { ...freeLocal, modelId: "own2", baseUrl: "http://192.168.1.20:5432/v1" }, session));
    await refused(createModel(db.pool, { ...freeLocal, modelId: "own3", baseUrl: "http://localhost:6379" }, session));
    // an existing free model whose URL later turns out to be an own service is unpriced again, never free
    const ok = await createModel(db.pool, freeLocal, session);
    expect(ok.endpointKind).toBe("local");
    await db.ownerPool.query("update llm_models set base_url = 'http://localhost:5432/v1' where id = $1", [ok.id]);
    const stored = (await listModels(db.pool))[0]!;
    expect(priceCardFor(stored, [])).toBeUndefined();
  });

  it("a_duplicate_is_refused_in_words", async () => {
    await createModel(db.pool, paid, session);
    await expect(createModel(db.pool, paid, session)).rejects.toThrow(/already in the catalog/);
  });
});

describe("stored prices cannot be tampered into a free ride (app role)", () => {
  const tamper = (id: string, prices: string) => db.pool.query("update llm_models set prices = $2::jsonb where id = $1", [id, prices]);
  const cases: [string, string][] = [
    ["zero input and output", '{"inputPerMTokMicro":0,"outputPerMTokMicro":0}'],
    ["string prices", '{"inputPerMTokMicro":"3000000","outputPerMTokMicro":"15000000"}'],
    ["empty object", "{}"],
    ["unknown key", '{"inputPerMTokMicro":1,"outputPerMTokMicro":1,"freeLunch":1}'],
    ["negative optional", '{"inputPerMTokMicro":1,"outputPerMTokMicro":1,"cacheReadPerMTokMicro":-1}'],
    ["fractional", '{"inputPerMTokMicro":1.5,"outputPerMTokMicro":1}'],
    ["array", "[1,2]"],
  ];
  it.each(cases)("%s is rejected by the database", async (_n, prices) => {
    const m = await createModel(db.pool, paid, session);
    await expect(tamper(m.id, prices)).rejects.toMatchObject({ code: "23514" });
    const back = (await listModels(db.pool))[0]!;
    expect(parseStoredPrices(back.prices)).not.toBeNull(); // the good row is unchanged
  });
  it("the_reader_refuses_a_bad_block_even_if_the_constraint_is_gone", async () => {
    const m = await createModel(db.pool, paid, session);
    await db.ownerPool.query("alter table llm_models drop constraint llm_models_price_shape");
    try {
      await tamper(m.id, '{"inputPerMTokMicro":0,"outputPerMTokMicro":0}');
      const back = (await listModels(db.pool))[0]!;
      expect(back.prices).toBeNull();
      expect(priceCardFor(back, [])).toBeUndefined();
    } finally {
      await db.ownerPool.query("update llm_models set prices = '{\"inputPerMTokMicro\":1,\"outputPerMTokMicro\":1}'");
      await db.ownerPool.query(await readFile("src/server/db/migrations/0011_llm_price_checks.sql", "utf8"));
    }
  });
  it("the_app_role_has_no_trigger_or_references_on_the_suggestions", async () => {
    const r = await db.pool.query("select has_table_privilege('ytstudio_app','model_catalog_defaults','TRIGGER') t, has_table_privilege('ytstudio_app','model_catalog_defaults','REFERENCES') r");
    expect(r.rows[0]).toEqual({ t: false, r: false });
  });
});

describe("routes", () => {
  it("routes_only_to_enabled_priced_capable_models", async () => {
    const good = await createModel(db.pool, paid, session);
    const off = await createModel(db.pool, { ...paid, modelId: "off", enabled: false }, session);
    const noVision = good;
    await setRoute(db.pool, "outline", good.id, session);
    expect(await listRoutes(db.pool)).toEqual({ outline: good.id });
    await refused(setRoute(db.pool, "outline", off.id, session));
    await refused(setRoute(db.pool, "qa_vision", noVision.id, session)); // lacks image input
    await refused(setRoute(db.pool, "nope", good.id, session));
    await refused(setRoute(db.pool, "outline", "not-a-uuid", session));
    await refused(setRoute(db.pool, "outline", "00000000-0000-4000-8000-000000000000", session));
  });

  it("the_picker_offers_only_satisfying_models", async () => {
    const a = await createModel(db.pool, paid, session);
    await createModel(db.pool, { ...paid, modelId: "nostruct", capabilities: { ...caps, structuredOutput: false } }, session);
    await createModel(db.pool, { ...paid, modelId: "draft", enabled: false, prices: null }, session);
    const local = await createModel(db.pool, freeLocal, session);
    const offered = modelsForStage("build_scene_kit", await listModels(db.pool), []).map((x) => x.model.id);
    expect(offered.sort()).toEqual([a.id, local.id].sort()); // scene build sends no tools; the others fail structured output or are unusable
    expect(modelsForStage("draft", await listModels(db.pool), []).map((x) => x.model.id).sort()).toEqual([a.id, local.id].sort());
  });

  it("a_routed_model_cannot_be_deleted_disabled_unpriced_or_stripped_of_a_capability", async () => {
    const m = await createModel(db.pool, paid, session);
    await setRoute(db.pool, "build_scene_kit", m.id, session);
    await refused(deleteModel(db.pool, m.id, session));
    await refused(updateModel(db.pool, m.id, { ...paid, enabled: false }, session));
    await refused(updateModel(db.pool, m.id, { ...paid, prices: null, enabled: false }, session));
    await refused(updateModel(db.pool, m.id, { ...paid, capabilities: { ...caps, structuredOutput: false } }, session));
    // Raw SQL cannot delete it either (foreign key).
    await expect(db.pool.query("delete from llm_models where id = $1", [m.id])).rejects.toMatchObject({ code: "23503" });
    expect((await listModels(db.pool)).length).toBe(1);
    await setRoute(db.pool, "build_scene_kit", null, session);
    await deleteModel(db.pool, m.id, session);
  });

  it("a_routed_free_model_cannot_be_moved_off_the_machine_or_survive_an_allow_list_removal", async () => {
    await setSetting(db.pool, "network.local_services", ["192.168.1.20:11434"], session);
    const lan = { ...freeLocal, modelId: "lan", baseUrl: "http://192.168.1.20:11434/v1", capabilities: { ...caps, toolUse: false } };
    const m = await createModel(db.pool, lan, session);
    await setRoute(db.pool, "outline", m.id, session);
    await refused(updateModel(db.pool, m.id, { ...lan, baseUrl: "https://api.x.test/v1" }, session)); // free but hosted
    await refused(updateModel(db.pool, m.id, { ...lan, baseUrl: "http://192.168.1.99:11434/v1" }, session)); // other LAN host, not listed
    await setSetting(db.pool, "network.local_services", [], session);
    await refused(updateModel(db.pool, m.id, lan, session)); // no longer local
    await refused(setRoute(db.pool, "titles", m.id, session)); // and no new route to it
    expect(modelsForStage("outline", await listModels(db.pool), [])).toEqual([]);
  });

  it("setRoute_and_updateModel_racing_never_leave_a_route_on_a_disabled_model", async () => {
    for (let i = 0; i < 15; i++) {
      await db.ownerPool.query("truncate llm_routes, llm_models cascade");
      const m = await createModel(db.pool, paid, session);
      await Promise.allSettled([setRoute(db.pool, "outline", m.id, session), updateModel(db.pool, m.id, { ...paid, enabled: false }, session)]);
      const bad = await db.pool.query("select 1 from llm_routes r join llm_models m on m.id = r.model_id where not m.enabled");
      expect(bad.rowCount, `round ${i}`).toBe(0);
    }
  });

  it("route_changes_are_audited_with_from_and_to", async () => {
    const a = await createModel(db.pool, paid, session);
    const b = await createModel(db.pool, { ...paid, modelId: "m-2" }, session);
    await setRoute(db.pool, "titles", a.id, session);
    await setRoute(db.pool, "titles", b.id, session);
    await setRoute(db.pool, "titles", null, session);
    const r = (await audit()).filter((x) => x.event === "route.changed").map((x) => x.detail);
    expect(r).toEqual([
      { stage: "titles", from: null, to: a.id },
      { stage: "titles", from: a.id, to: b.id },
      { stage: "titles", from: b.id, to: null },
    ]);
  });
});

describe("suggestions", () => {
  it("are_read_only_for_the_app_role_and_copy_disabled_and_unpriced", async () => {
    // reset() style truncation removed the seed in other suites; reload it here as the owner.
    await db.ownerPool.query("truncate model_catalog_defaults");
    await db.ownerPool.query(await readFile("src/server/db/migrations/0009_llm_catalog.sql", "utf8"));
    const defs = await listDefaults(db.pool);
    expect(defs.length).toBeGreaterThanOrEqual(4);
    await expect(db.pool.query("update model_catalog_defaults set label = 'x'")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("delete from model_catalog_defaults")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("insert into model_catalog_defaults (id, provider, model_id, label, capabilities) values ('z','x','x','x','{}')")).rejects.toMatchObject({ code: "42501" });

    const hosted = defs.find((d) => !d.isFree)!;
    const copy = await copyDefault(db.pool, hosted.id, session);
    expect(copy.enabled).toBe(false);
    expect(copy.prices).toBeNull();
    const local = await copyDefault(db.pool, defs.find((d) => d.isFree)!.id, session);
    expect(local.isFree).toBe(true);
    await refused(copyDefault(db.pool, "nope", session));
  });
});

describe("audit", () => {
  it("every_change_is_audited_and_carries_no_secret_shaped_value", async () => {
    const m = await createModel(db.pool, { ...paid, label: "k".repeat(10) }, session);
    await updateModel(db.pool, m.id, paid, session);
    const rows = await audit();
    expect(rows.map((r) => r.event)).toEqual(["model.added", "model.changed"]);
    expect(JSON.stringify(rows)).not.toMatch(/redacted/);
    expect(rows[0].detail).toMatchObject({ provider: "anthropic", model: "m-1", priced: true, free: false, endpoint: "hosted" });
  });
});
