import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setQuotaRpcForTests, type QuotaRpc } from "../src/services/quota/tokenQuotaService.js";
import { cancelMultiplier, publishMultipliers, resolveMultiplier, type MultiplierRow } from "../src/services/quota/multipliers.js";

/**
 * Migration 0059 (model usage multipliers) on a real Postgres, on top of 0057:
 *   QUOTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test
 * Skipped without it (CI has no Postgres).
 */
const ADMIN_URL = process.env.QUOTA_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !ADMIN_URL ? "set QUOTA_TEST_DATABASE_URL to run the Postgres multiplier tests" : false;

type Pool = import("pg").Pool;
let admin: Pool;
let pool: Pool;
let dbName = "";
let actor = "";

before(async () => {
  if (!ADMIN_URL) return;
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric → number (multipliers, costs)
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `mult_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  // Supabase's auth.users, as far as the foreign keys need it.
  await pool.query("create schema if not exists auth; create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz not null default now())");
  await pool.query(await readFile(path.join(here, "fixtures/quota-bootstrap.sql"), "utf8"));
  const m57 = await readFile(path.join(here, "../../supabase/migrations/0057_monthly_token_allowance.sql"), "utf8");
  const m59 = await readFile(path.join(here, "../../supabase/migrations/0059_model_multipliers.sql"), "utf8");
  await pool.query(m57);
  await pool.query(m59);
  await pool.query(m59); // must be safe to run twice
  await pool.query(await readFile(path.join(here, "../../supabase/migrations/0060_credit_grants.sql"), "utf8"));
  actor = (await pool.query("insert into auth.users default values returning id")).rows[0].id;

  const rpc: QuotaRpc = async <T>(fn: string, args: Record<string, unknown>) => {
    const names = Object.keys(args);
    const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
    const res = await pool.query(`select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`, values);
    // Set-returning / row-returning functions come back as rows (like PostgREST); scalars unwrap.
    return (res.fields.length === 1 && res.fields[0]!.name === fn ? res.rows[0]?.[fn] : fn === "model_multiplier_cancel" ? res.rows[0] : res.rows) as T;
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

async function rows(model: string): Promise<MultiplierRow[]> {
  const r = await pool.query("select * from model_multipliers where model_id = $1 order by created_at desc, id desc", [model]);
  return r.rows.map((x) => ({ ...x, effective_from: x.effective_from.toISOString(), effective_to: x.effective_to?.toISOString() ?? null, created_at: x.created_at.toISOString(), cancelled_at: x.cancelled_at?.toISOString() ?? null }));
}

test("publish → resolve: a new base value applies to calls after it, history keeps the old row", { skip }, async () => {
  const [first] = await publishMultipliers([{ provider_slug: "anthropic", model_id: "opus-a", multiplier: 2, kind: "base", reason: "launch price", expected_latest: null }], actor);
  assert.equal(Number(first!.multiplier), 2);
  const [second] = await publishMultipliers([{ provider_slug: "anthropic", model_id: "opus-a", multiplier: 5, kind: "base", reason: "provider raised prices", expected_latest: first!.id }], actor);
  const all = await rows("opus-a");
  assert.equal(all.length, 2, "append-only: the old version is still there");
  assert.equal(resolveMultiplier(all, "anthropic", "opus-a", Date.now() + 1000).multiplier, 5);
  assert.equal(resolveMultiplier(all, "anthropic", "opus-a", Date.now() + 1000).id, second!.id);
  assert.equal(all.find((r) => r.id === first!.id)?.cancelled_at, null, "the old version is history, not deleted or cancelled");
});

test("a stale screen can't overwrite a teammate's change (409), and a bulk publish is all-or-nothing", { skip }, async () => {
  const [a] = await publishMultipliers([{ provider_slug: "openai", model_id: "gpt-a", multiplier: 1.5, kind: "base", reason: "initial", expected_latest: null }], actor);
  await publishMultipliers([{ provider_slug: "openai", model_id: "gpt-a", multiplier: 3, kind: "base", reason: "teammate", expected_latest: a!.id }], actor);
  await assert.rejects(
    publishMultipliers([{ provider_slug: "openai", model_id: "gpt-a", multiplier: 9, kind: "base", reason: "stale screen", expected_latest: a!.id }], actor),
    (err: { status?: number }) => err.status === 409,
  );
  await assert.rejects(
    publishMultipliers(
      [
        { provider_slug: "openai", model_id: "gpt-b", multiplier: 2, kind: "base", reason: "bulk", expected_latest: null },
        { provider_slug: "openai", model_id: "gpt-a", multiplier: 2, kind: "base", reason: "bulk", expected_latest: a!.id },
      ],
      actor,
    ),
    (err: { status?: number }) => err.status === 409,
  );
  assert.equal((await rows("gpt-b")).length, 0, "nothing from the refused batch was written");
});

test("concurrent publishes for one model: exactly one wins", { skip }, async () => {
  const attempts = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => publishMultipliers([{ provider_slug: "gemini", model_id: "race", multiplier: i + 1, kind: "base", reason: `race ${i}`, expected_latest: null }], actor)),
  );
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  assert.equal((await rows("race")).length, 1);
});

test("cancel: scheduled rows and running promos can be withdrawn; an active base can't", { skip }, async () => {
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const later = new Date(Date.now() + 7_200_000).toISOString();
  const [base] = await publishMultipliers([{ provider_slug: "x", model_id: "c-1", multiplier: 2, kind: "base", reason: "now", expected_latest: null }], actor);
  const [scheduled] = await publishMultipliers([{ provider_slug: "x", model_id: "c-1", multiplier: 4, kind: "base", effective_from: soon, reason: "later", expected_latest: base!.id }], actor);
  const [promo] = await publishMultipliers([{ provider_slug: "x", model_id: "c-1", multiplier: 0, kind: "promo", effective_to: later, reason: "free week", expected_latest: scheduled!.id }], actor);
  await assert.rejects(cancelMultiplier(base!.id, actor), (err: { status?: number }) => err.status === 409);
  const c1 = await cancelMultiplier(scheduled!.id, actor);
  const c2 = await cancelMultiplier(promo!.id, actor);
  assert.ok(c1.cancelled_at && c2.cancelled_at);
  const live = (await rows("c-1")).filter((r) => !r.cancelled_at);
  assert.equal(resolveMultiplier(live, "x", "c-1", Date.now() + 5_000_000).multiplier, 2, "back to the standing value");
});

test("backdating is impossible even if the API check were bypassed (SQL clamps to now)", { skip }, async () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const res = await pool.query("select * from model_multiplier_publish($1::jsonb, $2)", [
    JSON.stringify([{ provider_slug: "y", model_id: "bd", multiplier: 3, kind: "base", effective_from: past, reason: "sneaky", expected_latest: null }]),
    actor,
  ]);
  assert.ok(res.rows[0].effective_from.getTime() > Date.now() - 60_000);
});

test("quota_record_usage stores the applied multiplier; the usage report recomputes base for old rows", { skip }, async () => {
  const user = (await pool.query("insert into profiles (plan) values ('pro') returning id")).rows[0].id;
  const rid = randomUUID();
  const allowances = { free: 1_000_000, pro: 10_000_000, premium: 25_000_000, enterprise_per_seat: 30_000_000, enterprise_min_seats: 3 };
  await pool.query("select quota_reserve(p_reservation => $1, p_user => $2, p_org => null, p_amount => 100, p_allowances => $3)", [rid, user, JSON.stringify(allowances)]);
  const mid = randomUUID();
  const event = (key: string, extra: Record<string, unknown>) =>
    JSON.stringify({ idempotency_key: key, provider_slug: "anthropic", model_id: "opus-r", input_tokens: 1000, cached_tokens: 600, output_tokens: 200, total_tokens: 1200, ...extra });
  await pool.query("select quota_record_usage($1, $2)", [rid, event("k1", { billable_tokens: 2640, base_billable_tokens: 660, usage_multiplier: 4, multiplier_id: mid })]);
  // A pre-0059 style row: no base/multiplier fields.
  await pool.query("select quota_record_usage($1, $2)", [rid, event("k2", { billable_tokens: 660 })]);
  const stored = await pool.query("select billable_tokens, base_billable_tokens, usage_multiplier, multiplier_id from token_ledger where idempotency_key = 'k1'");
  assert.deepEqual(stored.rows[0], { billable_tokens: 2640, base_billable_tokens: 660, usage_multiplier: 4, multiplier_id: mid });
  const acc = await pool.query("select used from quota_accounts where user_id = $1", [user]);
  assert.equal(acc.rows[0].used, 2640 + 660, "the balance is charged the weighted figure");
  const report = (await pool.query("select * from model_multiplier_usage(now() - interval '1 day') where model_id = 'opus-r'")).rows[0];
  assert.equal(report.base_billable, 660 + 660, "row 2's base is recomputed from its raw columns");
  assert.equal(report.billable, 2640 + 660);
  assert.deepEqual((await pool.query("select * from quota_audit()")).rows, [], "ledger and balances still agree");
});
