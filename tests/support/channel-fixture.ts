import type pg from "pg";

/**
 * A connected channel row for tests that approve or run a publish (the publish path refuses a channel id with no row).
 * Defaults match the old global caps (6 a day, no spacing) so tests that start several uploads keep working.
 */
export async function ensureChannel(
  db: Pick<pg.Pool, "query">,
  channelId: string,
  o: { status?: string; maxPerDay?: number; minHours?: number; production?: boolean; allowPublic?: boolean } = {},
): Promise<void> {
  const a = await db.query<{ id: string }>(
    "insert into google_accounts (google_sub, email) values ('fixture-sub', 'fixture@example.com') on conflict (google_sub) do update set email = excluded.email returning id",
  );
  await db.query(
    `insert into youtube_channels (google_account_id, channel_id, title, token_secret_name, status, max_uploads_per_day, min_hours_between_uploads, production, allow_public)
     values ($1, $2, 'Fixture', $3, $4, $5, $6, $7, $8) on conflict (channel_id) do nothing`,
    [a.rows[0]!.id, channelId, `tok-${channelId.toLowerCase()}`, o.status ?? "connected", o.maxPerDay ?? 6, o.minHours ?? 0, o.production ?? false, o.allowPublic ?? false],
  );
}
