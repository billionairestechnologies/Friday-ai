import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration 0062 (one-time popups + inbox) on a real Postgres:
 *   QUOTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test
 * Skipped without it (CI has no Postgres).
 */
const ADMIN_URL = process.env.QUOTA_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !ADMIN_URL ? "set QUOTA_TEST_DATABASE_URL to run the Postgres popup tests" : false;

type Pool = import("pg").Pool;
let admin: Pool;
let pool: Pool;
let dbName = "";

const slice = (sql: string, from: string, to: string) => sql.slice(sql.indexOf(from), sql.indexOf(to));

before(async () => {
  if (!ADMIN_URL) return;
  const pg = (await import("pg")).default;
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `popup_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 16 });
  await pool.query("create schema auth; create table auth.users (id uuid primary key default gen_random_uuid()); create table public.profiles (id uuid primary key references auth.users (id))");
  const m31 = await readFile(path.join(here, "../../supabase/migrations/0031_add_team_console.sql"), "utf8");
  await pool.query(slice(m31, "create table if not exists public.announcements", "-- ── Marketing email"));
  const m60 = await readFile(path.join(here, "../../supabase/migrations/0060_credit_grants.sql"), "utf8");
  await pool.query(slice(m60, "create table if not exists public.user_notifications", "-- The one balance rule."));
  // A view recorded before 0062 (old primary key) must survive the key change.
  const legacyUser = (await pool.query("insert into auth.users default values returning id")).rows[0].id;
  const legacy = (await pool.query("insert into announcements (title, status, publish_at) values ('old', 'published', now()) returning id")).rows[0].id;
  await pool.query("insert into announcement_views (announcement_id, user_id) values ($1, $2)", [legacy, legacyUser]);
  const m62 = await readFile(path.join(here, "../../supabase/migrations/0062_popups_inbox.sql"), "utf8");
  await pool.query(m62);
  await pool.query(m62); // must be safe to run twice
  const kept = await pool.query("select version, state from announcement_views where announcement_id = $1", [legacy]);
  assert.deepEqual(kept.rows, [{ version: 1, state: "acknowledged" }]);
});

after(async () => {
  if (!ADMIN_URL) return;
  await pool.end();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

async function user(): Promise<string> {
  const id = (await pool.query("insert into auth.users default values returning id")).rows[0].id as string;
  await pool.query("insert into profiles (id) values ($1)", [id]);
  return id;
}
async function announcement(): Promise<string> {
  return (await pool.query("insert into announcements (title, status, publish_at) values ('New: Credits', 'published', now()) returning id")).rows[0].id;
}
const claim = async (a: string, u: string, v = 1) => (await pool.query("select announcement_claim($1, $2, $3, 'web') as ok", [a, u, v])).rows[0].ok as boolean;
const act = (a: string, u: string, state: string, v = 1) => pool.query("select announcement_act($1, $2, $3, $4)", [a, u, v, state]);
const state = async (a: string, u: string, v = 1) => (await pool.query("select state, clicked from announcement_views where announcement_id = $1 and user_id = $2 and version = $3", [a, u, v])).rows[0];

test("five tabs racing to show the same popup: exactly one shows it", { skip }, async () => {
  const a = await announcement();
  const u = await user();
  const results = await Promise.all(Array.from({ length: 5 }, () => claim(a, u)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await claim(a, u), false, "and never again (another device, a refresh)");
});

test("nothing is recorded until a popup is actually displayed", { skip }, async () => {
  const a = await announcement();
  const u = await user();
  await act(a, u, "acknowledged"); // acting on something never displayed changes nothing
  assert.equal(await state(a, u), undefined);
  assert.equal(await claim(a, u), true);
  assert.deepEqual(await state(a, u), { state: "displayed", clicked: false });
});

test("state only moves forward: displayed → dismissed/acknowledged; a CTA click always wins", { skip }, async () => {
  const a = await announcement();
  const u = await user();
  await claim(a, u);
  await act(a, u, "dismissed");
  await act(a, u, "acknowledged");
  assert.deepEqual(await state(a, u), { state: "dismissed", clicked: false }, "first outcome is kept");
  await act(a, u, "clicked");
  assert.deepEqual(await state(a, u), { state: "clicked", clicked: true });
  await assert.rejects(act(a, u, "displayed"), /bad_state/);
});

test("a new version is shown again (once); the old version's record stays", { skip }, async () => {
  const a = await announcement();
  const u = await user();
  assert.equal(await claim(a, u, 1), true);
  await act(a, u, "acknowledged", 1);
  await pool.query("update announcements set version = 2 where id = $1", [a]);
  assert.equal(await claim(a, u, 2), true);
  assert.equal(await claim(a, u, 2), false);
  assert.equal((await pool.query("select count(*)::int as n from announcement_views where announcement_id = $1 and user_id = $2", [a, u])).rows[0].n, 2);
});

test("benefit popups are claimed once across tabs; only popup notifications of their owner", { skip }, async () => {
  const u = await user();
  const other = await user();
  const n = (await pool.query("insert into user_notifications (user_id, kind, title, popup) values ($1, 'credit_granted', '5M bonus tokens', true) returning id", [u])).rows[0].id;
  const inboxOnly = (await pool.query("insert into user_notifications (user_id, kind, title) values ($1, 'program_needs_info', 'More info') returning id", [u])).rows[0].id;
  const claimN = async (id: string, who: string) => (await pool.query("select notification_claim($1, $2) as ok", [id, who])).rows[0].ok as boolean;
  assert.equal(await claimN(n, other), false, "someone else's notification can't be claimed");
  const results = await Promise.all(Array.from({ length: 4 }, () => claimN(n, u)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await claimN(inboxOnly, u), false, "inbox-only items never pop up");
  const row = (await pool.query("select seen_at is not null as seen from user_notifications where id = $1", [n])).rows[0];
  assert.equal(row.seen, true, "displayed counts as seen in the inbox");
});

test("benefits granted before 0062 become popups (they were never shown)", { skip }, async () => {
  const cols = (await pool.query("select popup from user_notifications where kind = 'credit_granted'")).rows;
  assert.ok(cols.every((r) => r.popup === true));
});
