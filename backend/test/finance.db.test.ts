import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration 0063 (payment ledger + revenue recognition) on a real Postgres:
 *   QUOTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test
 * Skipped without it (CI has no Postgres).
 */
const ADMIN_URL = process.env.QUOTA_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !ADMIN_URL ? "set QUOTA_TEST_DATABASE_URL to run the Postgres finance tests" : false;

type Pool = import("pg").Pool;
let admin: Pool;
let pool: Pool;
let dbName = "";
let migration = "";
let alice = "";

before(async () => {
  if (!ADMIN_URL) return;
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => Number(v));
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `fin_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await pool.query(`
    create table public.profiles (id uuid primary key default gen_random_uuid());
    create table public.organizations (id uuid primary key default gen_random_uuid());
    create table public.plan_packages (id uuid primary key default gen_random_uuid(), duration_days int);
    create table public.razorpay_orders (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, organization_id uuid, plan text not null,
      amount_paise int not null, currency text not null default 'INR', razorpay_order_id text not null unique,
      razorpay_payment_id text, status text not null default 'created', metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
  alice = (await pool.query("insert into profiles default values returning id")).rows[0].id;
  // Orders that exist before the migration: a paid monthly, a paid annual, an unpaid one.
  await pool.query(
    `insert into razorpay_orders (user_id, plan, amount_paise, razorpay_order_id, razorpay_payment_id, status, metadata, updated_at) values
      ($1, 'pro', 31000, 'order_m', 'pay_m', 'paid', '{"billingCycle":"monthly"}', '2026-10-01T00:00:00Z'),
      ($1, 'premium', 365000, 'order_a', 'pay_a', 'paid', '{"billingCycle":"annual"}', '2026-01-01T00:00:00Z'),
      ($1, 'pro', 31000, 'order_x', null, 'created', '{}', '2026-10-02T00:00:00Z')`,
    [alice],
  );
  migration = await readFile(path.join(here, "../../supabase/migrations/0063_payment_ledger.sql"), "utf8");
  await pool.query(migration);
});

after(async () => {
  if (!ADMIN_URL) return;
  await pool.end();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

const revenue = async (from: string, to: string) => (await pool.query("select * from finance_revenue($1, $2)", [from, to])).rows[0];

test("backfill turns paid orders into payments once (re-running adds nothing)", { skip }, async () => {
  await pool.query(migration);
  const rows = (await pool.query("select provider_ref, amount_paise, term_start, term_end from payment_ledger order by provider_ref")).rows;
  assert.deepEqual(rows.map((r) => [r.provider_ref, r.amount_paise]), [["pay_a", 365000], ["pay_m", 31000]]);
  const annual = rows.find((r) => r.provider_ref === "pay_a")!;
  assert.equal(new Date(annual.term_end).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("cash is counted when received; revenue is earned straight-line over the term", { skip }, async () => {
  // October 1–16 (15 days): the monthly ₹310 for Oct 1 → Nov 1 (31 days) earns 15/31 = ₹150;
  // the annual ₹3650 for 2026 earns 15/365 of it = ₹150.
  const r = await revenue("2026-10-01T00:00:00Z", "2026-10-16T00:00:00Z");
  assert.equal(r.cash_in, 31000, "only the October payment was received in the window");
  assert.equal(r.recognised, 15000 + 15000);
  assert.equal(r.payments, 1);
  assert.equal(r.payers, 1);
  // Deferred at Oct 16: monthly 16/31 of ₹310 = ₹160, annual 77/365 of ₹3650 = ₹770.
  assert.equal(r.deferred_at_end, 16000 + 77000);
});

test("a whole term's window earns exactly the payment (no rounding drift)", { skip }, async () => {
  const r = await revenue("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
  assert.equal(r.cash_in, 365000 + 31000);
  assert.equal(r.recognised, 365000 + 31000);
  assert.equal(r.deferred_at_end, 0);
});

test("refunds and chargebacks reduce revenue when they happen; fees are summed and unknown fees flagged", { skip }, async () => {
  await pool.query(
    `insert into payment_ledger (provider_ref, kind, order_id, user_id, amount_paise, fee_paise, tax_paise, occurred_at, term_start, term_end) values
      ('pay_n', 'payment', 'order_n', $1, 50000, 1180, 180, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
      ('rfnd_1', 'refund', 'order_n', $1, 20000, null, null, '2026-11-10T00:00:00Z', null, null),
      ('disp_1', 'chargeback', 'order_m', $1, 31000, null, null, '2026-11-12T00:00:00Z', null, null)`,
    [alice],
  );
  const r = await revenue("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
  assert.equal(r.cash_in, 50000);
  assert.equal(r.refunds, 20000);
  assert.equal(r.chargebacks, 31000);
  assert.equal(r.fees, 1180);
  assert.equal(r.fees_unknown, 0);
  // Earned in November: all of the new ₹500 + 30/365 of the annual ₹3650 (₹300) − ₹200 refund − ₹310 dispute.
  assert.equal(r.recognised, 50000 + 30000 - 20000 - 31000);
  const backfilled = await revenue("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
  assert.equal(backfilled.fees_unknown, 1, "the backfilled October payment has no fee on record");
});

test("a webhook delivered twice records the money once", { skip }, async () => {
  const ins = () =>
    pool.query("insert into payment_ledger (provider_ref, kind, amount_paise, occurred_at) values ('pay_dup', 'payment', 100, now()) on conflict (provider, provider_ref) do nothing returning id");
  const [a, b] = await Promise.all([ins(), ins()]);
  assert.equal(a.rowCount! + b.rowCount!, 1);
});

test("one order counts one payment even if both webhook events record it under different ids", { skip }, async () => {
  await pool.query("insert into payment_ledger (provider_ref, kind, order_id, amount_paise, occurred_at) values ('order:order_twice', 'payment', 'order_twice', 100, now())");
  await assert.rejects(pool.query("insert into payment_ledger (provider_ref, kind, order_id, amount_paise, occurred_at) values ('pay_twice', 'payment', 'order_twice', 100, now())"), /payment_ledger_one_payment_per_order/);
  await pool.query("delete from payment_ledger where order_id = 'order_twice'");
});

test("reconciliation finds paid orders without money, money without a paid order, and amount mismatches", { skip }, async () => {
  await pool.query("insert into razorpay_orders (user_id, plan, amount_paise, razorpay_order_id, status) values ($1, 'pro', 31000, 'order_lost', 'paid')", [alice]);
  await pool.query("insert into razorpay_orders (user_id, plan, amount_paise, razorpay_order_id, status) values ($1, 'pro', 31000, 'order_q', 'paid')", [alice]);
  await pool.query("insert into payment_ledger (provider_ref, kind, order_id, amount_paise, occurred_at) values ('pay_q', 'payment', 'order_q', 30000, now()), ('pay_x', 'payment', 'order_x', 31000, now())");
  const issues = (await pool.query("select issue, order_id from finance_reconciliation() order by order_id")).rows;
  const by = Object.fromEntries(issues.map((i) => [i.order_id, i.issue]));
  assert.match(by.order_lost, /without a payment record/);
  assert.match(by.order_x, /not marked paid/);
  assert.match(by.order_q, /differs/);
  assert.equal(by.order_m, undefined, "a healthy order isn't flagged");
});
