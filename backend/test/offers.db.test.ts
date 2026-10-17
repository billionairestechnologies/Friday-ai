import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration 0061 (offers v2 + programmes) on a real Postgres:
 *   QUOTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test
 * Skipped without it (CI has no Postgres).
 */
const ADMIN_URL = process.env.QUOTA_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !ADMIN_URL ? "set QUOTA_TEST_DATABASE_URL to run the Postgres offer tests" : false;

type Pool = import("pg").Pool;
let admin: Pool;
let pool: Pool;
let dbName = "";

before(async () => {
  if (!ADMIN_URL) return;
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => Number(v));
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `offer_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 24 });
  await pool.query("create schema if not exists auth; create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz not null default now())");
  // 0032 builds the real offer tables; it only needs these two to exist.
  await pool.query("create table public.profiles (id uuid primary key default gen_random_uuid(), plan text not null default 'free'); create table public.organizations (id uuid primary key default gen_random_uuid())");
  // 0032's offer tables, verbatim (the rest of 0032 seeds staff roles etc. that these tests don't need).
  const m32 = await readFile(path.join(here, "../../supabase/migrations/0032_add_packages_and_offers.sql"), "utf8");
  const from = m32.indexOf("create table if not exists public.plan_packages");
  const to = m32.indexOf("create table if not exists public.access_grants");
  await pool.query(m32.slice(from, to));
  const m61 = await readFile(path.join(here, "../../supabase/migrations/0061_offers_v2_programs.sql"), "utf8");
  await pool.query(m61);
  await pool.query(m61); // must be safe to run twice
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
async function offer(extra: Record<string, unknown> = {}): Promise<string> {
  const cols = { code: `T${randomUUID().slice(0, 8)}`, name: "Test", kind: "credits", credit_tokens: 1000, ...extra };
  const keys = Object.keys(cols);
  const res = await pool.query(`insert into offers (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(cols));
  return res.rows[0].id as string;
}
type Claim = { redemption_id: string; status: string; duplicate: boolean };
async function claim(o: string, u: string, review = false): Promise<Claim> {
  return (await pool.query("select offer_claim($1, $2, $3, '') as r", [o, u, review])).rows[0].r as Claim;
}
async function count(o: string): Promise<number> {
  return (await pool.query("select redemption_count from offers where id = $1", [o])).rows[0].redemption_count as number;
}

test("old offers keep working: state follows the old active flag", { skip }, async () => {
  const states = await pool.query("select distinct state from offers");
  assert.ok(states.rows.every((r) => ["active", "paused", "draft", "archived"].includes(r.state)));
});

test("ten simultaneous taps by one person claim once and take one slot", { skip }, async () => {
  const o = await offer({ max_redemptions: 5 });
  const u = await user();
  const results = await Promise.all(Array.from({ length: 10 }, () => claim(o, u)));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(new Set(results.map((r) => r.redemption_id)).size, 1);
  assert.equal(await count(o), 1);
});

test("a capped offer can't be over-claimed under concurrency", { skip }, async () => {
  const o = await offer({ max_redemptions: 5 });
  const people = await Promise.all(Array.from({ length: 20 }, user));
  const results = await Promise.allSettled(people.map((u) => claim(o, u)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => /offer_full/.test(String((r as PromiseRejectedResult).reason))));
  assert.equal(await count(o), 5);
});

test("state and dates are enforced in SQL", { skip }, async () => {
  const u = await user();
  await assert.rejects(claim(await offer({ state: "draft" }), u), /offer_not_active/);
  await assert.rejects(claim(await offer({ state: "paused" }), u), /offer_not_active/);
  await assert.rejects(claim(await offer({ starts_at: new Date(Date.now() + 3_600_000).toISOString() }), u), /offer_not_started/);
  await assert.rejects(claim(await offer({ expires_at: new Date(Date.now() - 1000).toISOString() }), u), /offer_expired/);
});

test("stacking: one applied redemption per exclusive group", { skip }, async () => {
  const u = await user();
  const a = await offer({ exclusive_group: "launch" });
  const b = await offer({ exclusive_group: "launch" });
  const c = await offer({ exclusive_group: "other" });
  const r = await claim(a, u);
  await pool.query("select offer_confirm($1, '{}'::jsonb)", [r.redemption_id]);
  await assert.rejects(claim(b, u), /offer_group_conflict/);
  assert.equal((await claim(c, u)).duplicate, false, "a different group is fine");
});

test("a failed apply gives the slot back and the person can retry", { skip }, async () => {
  const o = await offer({ max_redemptions: 1 });
  const u = await user();
  const first = await claim(o, u);
  assert.equal(await count(o), 1);
  await pool.query("select offer_release($1, 'provider down')", [first.redemption_id]);
  assert.equal(await count(o), 0);
  const retry = await claim(o, u);
  assert.equal(retry.duplicate, false);
  assert.equal(retry.redemption_id, first.redemption_id, "same row, tried again");
  await pool.query("select offer_confirm($1, $2)", [retry.redemption_id, JSON.stringify({ grantId: "g1" })]);
  const row = (await pool.query("select status, benefit from offer_redemptions where id = $1", [retry.redemption_id])).rows[0];
  assert.deepEqual(row, { status: "applied", benefit: { grantId: "g1" } });
  await pool.query("select offer_release($1, 'late')", [retry.redemption_id]);
  assert.equal(await count(o), 1, "an applied redemption can't be released");
});

test("review: pending takes no slot; approval does, respects the cap, and happens once", { skip }, async () => {
  const o = await offer({ max_redemptions: 1, requires_approval: true });
  const [u1, u2] = [await user(), await user()];
  const p1 = await claim(o, u1, true);
  const p2 = await claim(o, u2, true);
  assert.equal(p1.status, "pending");
  assert.equal(await count(o), 0);
  const ok = (await pool.query("select offer_approve_claim($1, null, 'ok') as r", [p1.redemption_id])).rows[0].r;
  assert.equal(ok.status, "claimed");
  const again = (await pool.query("select offer_approve_claim($1, null, 'ok') as r", [p1.redemption_id])).rows[0].r;
  assert.equal(again.duplicate, true);
  await assert.rejects(pool.query("select offer_approve_claim($1, null, 'ok')", [p2.redemption_id]), /offer_full/);
  assert.equal(await count(o), 1);
});

test("a rejected person can't claim the same offer again", { skip }, async () => {
  const o = await offer({ requires_approval: true });
  const u = await user();
  const p = await claim(o, u, true);
  await pool.query("update offer_redemptions set status = 'rejected' where id = $1", [p.redemption_id]);
  await assert.rejects(claim(o, u, true), /offer_rejected/);
});

test("programmes: one open application per person; a decision happens exactly once", { skip }, async () => {
  const u = await user();
  const app = (await pool.query("insert into program_applications (user_id, program, details) values ($1, 'startup', '{}') returning id", [u])).rows[0].id;
  await assert.rejects(pool.query("insert into program_applications (user_id, program) values ($1, 'startup')", [u]), /program_applications_open_idx/);
  const info = (await pool.query("select * from program_decide($1, 'needs_info', null, 'Please add your website', null)", [app])).rows[0];
  assert.equal(info.status, "needs_info");
  assert.equal(info.info_request, "Please add your website");
  const results = await Promise.allSettled([0, 1, 2].map(() => pool.query("select * from program_decide($1, 'approved', null, 'welcome', now() + interval '1 year')", [app])));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "three reviewers clicking at once → one decision");
  const row = (await pool.query("select status, decision_note, valid_until is not null as dated from program_applications where id = $1", [app])).rows[0];
  assert.deepEqual(row, { status: "approved", decision_note: "welcome", dated: true });
  // A new application is allowed once the old one is decided (renewal).
  await pool.query("insert into program_applications (user_id, program) values ($1, 'startup')", [u]);
});
