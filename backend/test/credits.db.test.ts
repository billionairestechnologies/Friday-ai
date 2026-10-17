import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setQuotaRpcForTests, type QuotaRpc } from "../src/services/quota/tokenQuotaService.js";
import { approveGrant, grantCredits, revokeGrant } from "../src/services/quota/credits.js";

/**
 * Migration 0060 (credit grants with real expiry) on a real Postgres, on top of 0057 + 0059:
 *   QUOTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test
 * Skipped without it (CI has no Postgres).
 */
const ADMIN_URL = process.env.QUOTA_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !ADMIN_URL ? "set QUOTA_TEST_DATABASE_URL to run the Postgres credit tests" : false;
const ALLOWANCES = { free: 1_000_000, pro: 10_000_000, premium: 25_000_000, enterprise_per_seat: 30_000_000, enterprise_min_seats: 3 };

type Pool = import("pg").Pool;
let admin: Pool;
let pool: Pool;
let dbName = "";
let alice = ""; // staff
let bob = ""; // staff

before(async () => {
  if (!ADMIN_URL) return;
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => Number(v));
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `credit_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 16 });
  await pool.query("create schema if not exists auth; create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz not null default now())");
  await pool.query(await readFile(path.join(here, "fixtures/quota-bootstrap.sql"), "utf8"));
  for (const file of ["0057_monthly_token_allowance.sql", "0059_model_multipliers.sql", "0060_credit_grants.sql"]) {
    const sql = await readFile(path.join(here, "../../supabase/migrations", file), "utf8");
    await pool.query(sql);
    await pool.query(sql);
  }
  alice = (await pool.query("insert into auth.users default values returning id")).rows[0].id;
  bob = (await pool.query("insert into auth.users default values returning id")).rows[0].id;
  const rpc: QuotaRpc = async <T>(fn: string, args: Record<string, unknown>) => {
    const names = Object.keys(args);
    const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
    const res = await pool.query(`select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`, values);
    return (res.fields.length === 1 && res.fields[0]!.name === fn ? res.rows[0]?.[fn] : res.rows) as T;
  };
  setQuotaRpcForTests(rpc);
});

after(async () => {
  setQuotaRpcForTests(null);
  if (!ADMIN_URL) return;
  await pool.end();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

type Snap = { ok?: boolean; reason?: string; allowance: number; used: number; adjustments: number; reserved: number; remaining: number; credits: number; credit_drawn: number; grant_id?: string; status?: string; duplicate?: boolean; account_id: string; period_start: string };

async function one<T>(text: string, values: unknown[] = []): Promise<T> {
  return (await pool.query(text, values)).rows[0] as T;
}
async function newUser(plan = "free"): Promise<string> {
  return (await one<{ id: string }>("insert into profiles (plan) values ($1) returning id", [plan])).id;
}
async function reserve(user: string, amount: number, now?: string): Promise<Snap & { id: string }> {
  const id = randomUUID();
  const r = await one<{ r: Snap }>(
    "select quota_reserve(p_reservation => $1, p_user => $2, p_org => null, p_amount => $3, p_allowances => $4, p_now => coalesce($5::timestamptz, now())) as r",
    [id, user, amount, JSON.stringify(ALLOWANCES), now ?? null],
  );
  return { id, ...r.r };
}
async function spend(user: string, tokens: number, now?: string): Promise<Snap> {
  const r = await reserve(user, 0, now);
  const ev = { idempotency_key: randomUUID(), provider_slug: "p", model_id: "m", billable_tokens: tokens, input_tokens: tokens };
  const out = (await one<{ r: Snap }>("select quota_record_usage($1, $2, coalesce($3::timestamptz, now())) as r", [r.id, JSON.stringify(ev), now ?? null])).r;
  await pool.query("select quota_settle($1, 'settled', coalesce($2::timestamptz, now()))", [r.id, now ?? null]);
  return out;
}
async function grant(user: string, tokens: number, opts: { expires?: string | null; key?: string; approval?: boolean; actor?: string; now?: string } = {}): Promise<Snap> {
  return (
    await one<{ r: Snap }>(
      "select quota_grant_credits(p_user => $1, p_org => null, p_tokens => $2, p_expires_at => $3, p_kind => 'promotional', p_reason => 'test grant', p_actor => $4, p_key => $5, p_requires_approval => $6, p_now => coalesce($7::timestamptz, now())) as r",
      [user, tokens, opts.expires ?? null, opts.actor ?? alice, opts.key ?? randomUUID(), opts.approval ?? false, opts.now ?? null],
    )
  ).r;
}
async function audit() {
  return (await pool.query("select * from quota_audit()")).rows;
}

test("credits add to the balance; the month's allowance is spent first, then credits", { skip }, async () => {
  const user = await newUser();
  await reserve(user, 0).then((r) => pool.query("select quota_settle($1)", [r.id]));
  const g = await grant(user, 500_000);
  assert.equal(g.status, "active");
  assert.equal(g.credits, 500_000);
  assert.equal(g.remaining, 1_500_000);

  const a = await spend(user, 800_000);
  assert.equal(a.credits, 500_000, "still inside the allowance: credits untouched");
  const b = await spend(user, 300_000);
  assert.equal(b.credit_drawn, 100_000, "only the 100k past the allowance comes from credits");
  assert.equal(b.credits, 400_000);
  assert.equal(b.remaining, 400_000);
  const draws = await pool.query("select tokens from quota_credit_draws where grant_id = $1", [g.grant_id]);
  assert.deepEqual(draws.rows.map((r) => r.tokens), [100_000]);
  assert.deepEqual(await audit(), []);
});

test("credits survive the monthly rollover; the new month starts with its full allowance again", { skip }, async () => {
  const user = await newUser();
  const t0 = "2027-03-10T00:00:00Z";
  await reserve(user, 0, t0).then((r) => pool.query("select quota_settle($1, 'settled', $2)", [r.id, t0]));
  await grant(user, 300_000, { now: t0 });
  const s = await spend(user, 1_200_000, t0); // 1M allowance + 200k credits
  assert.equal(s.credits, 100_000);
  const next = await reserve(user, 0, "2027-04-10T00:00:01Z");
  assert.equal(next.used, 0);
  assert.equal(next.credit_drawn, 0);
  assert.equal(next.credits, 100_000, "unused credit carries over");
  assert.equal(next.remaining, 1_100_000);
  await pool.query("select quota_settle($1, 'settled', $2)", [next.id, "2027-04-10T00:00:01Z"]);
});

test("soonest-expiring grant is used first; expiry takes back only what's left", { skip }, async () => {
  const user = await newUser();
  const t0 = "2027-05-01T00:00:00Z";
  await reserve(user, 0, t0).then((r) => pool.query("select quota_settle($1, 'settled', $2)", [r.id, t0]));
  const late = await grant(user, 200_000, { now: t0, expires: "2027-08-01T00:00:00Z" });
  const soon = await grant(user, 200_000, { now: t0, expires: "2027-05-10T00:00:00Z" });
  await spend(user, 1_150_000, t0); // 150k past the allowance
  const g = await pool.query("select id, remaining from quota_credit_grants where id = any($1)", [[late.grant_id, soon.grant_id]]);
  const rem = Object.fromEntries(g.rows.map((r) => [r.id, r.remaining]));
  assert.equal(rem[soon.grant_id!], 50_000, "the soon-expiring grant paid");
  assert.equal(rem[late.grant_id!], 200_000);
  const after = await reserve(user, 0, "2027-05-10T00:00:00Z");
  assert.equal(after.credits, 200_000, "50k expired with its grant");
  const expired = await one<{ status: string; expired_tokens: number }>("select status, expired_tokens from quota_credit_grants where id = $1", [soon.grant_id]);
  assert.deepEqual(expired, { status: "expired", expired_tokens: 50_000 });
  await pool.query("select quota_settle($1, 'settled', $2)", [after.id, "2027-05-10T00:00:00Z"]);
  assert.deepEqual(await audit(), []);
});

test("a grant needing approval changes nothing until someone else approves it", { skip }, async () => {
  const user = await newUser();
  const g = await grant(user, 5_000_000, { approval: true, actor: alice });
  assert.equal(g.status, "pending");
  assert.equal(g.credits, 0);
  await assert.rejects(pool.query("select quota_approve_credit_grant($1, $2)", [g.grant_id, alice]), /self_approval/);
  const ok = (await one<{ r: Snap }>("select quota_approve_credit_grant($1, $2) as r", [g.grant_id, bob])).r;
  assert.equal(ok.credits, 5_000_000);
  const again = (await one<{ r: Snap }>("select quota_approve_credit_grant($1, $2) as r", [g.grant_id, bob])).r;
  assert.equal(again.duplicate, true);
  assert.equal(again.credits, 5_000_000, "approving twice credits once");
  assert.deepEqual(await audit(), []);
});

test("revoke takes back only the unused part; a pending grant is rejected instead", { skip }, async () => {
  const user = await newUser();
  await reserve(user, 0).then((r) => pool.query("select quota_settle($1)", [r.id]));
  const g = await grant(user, 400_000);
  await spend(user, 1_100_000);
  const r = (await one<{ r: Snap & { taken_back: number } }>("select quota_revoke_credit_grant($1, $2, 'mistake') as r", [g.grant_id, alice])).r;
  assert.equal(r.taken_back, 300_000);
  assert.equal(r.credits, 0);
  assert.equal(r.credit_drawn, 100_000, "what was used stays used");
  await assert.rejects(pool.query("select quota_revoke_credit_grant($1, $2, 'again')", [g.grant_id, alice]), /not_revocable/);
  const p = await grant(user, 9_000_000, { approval: true });
  const rej = (await one<{ r: { status: string } }>("select quota_revoke_credit_grant($1, $2, 'no') as r", [p.grant_id, bob])).r;
  assert.equal(rej.status, "rejected");
  assert.deepEqual(await audit(), []);
});

test("a retried / double-clicked grant (same key) credits once, even concurrently", { skip }, async () => {
  const user = await newUser();
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 12 }, () => grant(user, 250_000, { key })));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  const n = await one<{ n: number; credits: number }>("select (select count(*)::int from quota_credit_grants where idempotency_key = $1) as n, (select credits from quota_accounts where user_id = $2) as credits", [key, user]);
  assert.deepEqual(n, { n: 1, credits: 250_000 });
});

test("concurrent requests can't spend more than allowance + credits", { skip }, async () => {
  const user = await newUser();
  await reserve(user, 0).then((r) => pool.query("select quota_settle($1)", [r.id]));
  await grant(user, 500_000);
  const holds = await Promise.all(Array.from({ length: 40 }, () => reserve(user, 100_000)));
  assert.equal(holds.filter((h) => h.ok).length, 15, "1M allowance + 500k credits = 15 holds of 100k");
  for (const h of holds.filter((x) => x.ok)) {
    const ev = { idempotency_key: randomUUID(), provider_slug: "p", model_id: "m", billable_tokens: 100_000 };
    await pool.query("select quota_record_usage($1, $2)", [h.id, JSON.stringify(ev)]);
    await pool.query("select quota_settle($1)", [h.id]);
  }
  const acc = await one<Snap>("select *, quota_remaining(a) as remaining from quota_accounts a where user_id = $1", [user]);
  assert.equal(acc.remaining, 0);
  assert.equal(acc.credits, 0);
  assert.equal(acc.credit_drawn, 500_000);
  assert.deepEqual(await audit(), []);
});

test("without any grants the balance rule is exactly 0057's (credits and draws stay 0)", { skip }, async () => {
  const user = await newUser("pro");
  const s = await spend(user, 1_234);
  assert.equal(s.credits, 0);
  assert.equal(s.credit_drawn, 0);
  assert.equal(s.remaining, s.allowance - s.used - s.adjustments - s.reserved);
});

test("grant input is validated: positive tokens, future expiry, a key", { skip }, async () => {
  const user = await newUser();
  await assert.rejects(grant(user, 0), /tokens must be > 0/);
  await assert.rejects(grant(user, 10, { expires: "2001-01-01T00:00:00Z" }), /expiry must be in the future/);
  await assert.rejects(grant(user, 10, { key: "" }), /idempotency key/);
});

test("service layer: small grants are active at once; big ones wait for someone else; revoke by service", { skip }, async () => {
  const user = await newUser();
  // credit_settings can't be read through the placeholder Supabase client → the defaults apply (10M threshold).
  const small = await grantCredits({ userId: user, tokens: 2_000_000, expiresAt: null, kind: "goodwill", reason: "Sorry for the outage", key: randomUUID() }, alice);
  assert.equal(small.grantStatus, "active");
  assert.equal(small.credits, 2_000_000);
  const key = randomUUID();
  const big = await grantCredits({ userId: user, tokens: 50_000_000, expiresAt: null, kind: "program", reason: "Startup programme", key }, alice);
  assert.equal(big.grantStatus, "pending");
  assert.equal(big.credits, 2_000_000, "pending changes nothing");
  const again = await grantCredits({ userId: user, tokens: 50_000_000, expiresAt: null, kind: "program", reason: "Startup programme", key }, alice);
  assert.equal(again.duplicate, true, "double click");
  await assert.rejects(approveGrant(big.grantId, alice), (e: { status?: number }) => e.status === 403);
  const ok = await approveGrant(big.grantId, bob);
  assert.equal(ok.credits, 52_000_000);
  const r = await revokeGrant(small.grantId, bob, "granted twice by mistake");
  assert.deepEqual(r, { status: "revoked", takenBack: 2_000_000 });
  await assert.rejects(revokeGrant(small.grantId, bob, "again"), (e: { status?: number }) => e.status === 409);
  assert.deepEqual(await audit(), []);
});
