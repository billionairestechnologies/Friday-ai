import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addMonthsUtc } from "../src/services/quota/allowance.js";
import { billableTokens } from "../src/services/quota/allowance.js";
import { usageFromGemini, usageFromOpenAi, type TokenUsage } from "../src/services/tokenUsage.js";
import {
  checkAndReserve,
  getQuotaStatus,
  setPlanLookupForTests,
  setQuotaRpcForTests,
  type EffectivePlan,
  type QuotaRpc,
} from "../src/services/quota/tokenQuotaService.js";
import { setUsagePricerForTests, UsageMeter } from "../src/services/quota/usageMeter.js";

/**
 * The 0051 SQL functions on a real Postgres: locking under concurrency, periods, the subscription
 * lifecycle and the balance rule. Needs a server you can create databases on:
 *
 *   QUOTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test
 *
 * Skipped without it (CI has no Postgres). Each run creates and drops its own database.
 */
const ADMIN_URL = process.env.QUOTA_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const ALLOWANCES = { free: 1_000_000, pro: 10_000_000, premium: 25_000_000, enterprise_per_seat: 30_000_000, enterprise_min_seats: 3 };

type Pool = import("pg").Pool;
let admin: Pool;
let pool: Pool;
let dbName = "";

const skip = !ADMIN_URL ? "set QUOTA_TEST_DATABASE_URL to run the Postgres ledger tests" : false;

before(async () => {
  if (!ADMIN_URL) return;
  const pg = (await import("pg")).default;
  // bigint columns come back as JS numbers (all test values are far below 2^53).
  pg.types.setTypeParser(20, (v: string) => Number(v));
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `quota_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 16 });
  await pool.query(await readFile(path.join(here, "fixtures/quota-bootstrap.sql"), "utf8"));
  const migration = await readFile(path.join(here, "../../supabase/migrations/0051_monthly_token_allowance.sql"), "utf8");
  await pool.query(migration);
  await pool.query(migration); // must be safe to run twice

  const rpc: QuotaRpc = async <T>(fn: string, args: Record<string, unknown>) => {
    const names = Object.keys(args);
    const values = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
    const res = await pool.query(`select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`, values);
    return (res.fields.length === 1 && res.fields[0]!.name === fn ? res.rows[0]?.[fn] : res.rows) as T;
  };
  setQuotaRpcForTests(rpc);
  setUsagePricerForTests(async () => ({ costUsd: null, sellInr: null, priced: false }));
});

after(async () => {
  setQuotaRpcForTests(null);
  setPlanLookupForTests(null);
  setUsagePricerForTests(null);
  if (!ADMIN_URL) return;
  await pool.end();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

// ── helpers ─────────────────────────────────────────────────────────────────

async function sql<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, values)).rows as T[];
}
async function one<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T> {
  return (await sql<T>(text, values))[0]!;
}
async function newUser(plan = "free", renews: string | null = null, cap: number | null = null): Promise<string> {
  const row = await one<{ id: string }>("insert into profiles (plan, plan_renews_at, custom_monthly_cap) values ($1, $2, $3) returning id", [plan, renews, cap]);
  return row.id;
}
async function reserve(user: string, amount: number, now?: string, org: string | null = null) {
  const id = randomUUID();
  const res = await one<{ r: Record<string, unknown> }>(
    "select quota_reserve(p_reservation => $1, p_user => $2, p_org => $3, p_amount => $4, p_allowances => $5, p_now => coalesce($6::timestamptz, now())) as r",
    [id, user, org, amount, JSON.stringify(ALLOWANCES), now ?? null],
  );
  return { id, ...res.r } as { id: string; ok: boolean; reason?: string; used: number; reserved: number; remaining: number; allowance: number; period_start: string; period_end: string; plan: string; account_id: string };
}
async function record(reservation: string, billable: number, key = randomUUID(), now?: string, extra: Record<string, unknown> = {}) {
  const event = { idempotency_key: key, provider_slug: "openai", model_id: "gpt-5.6", input_tokens: billable, output_tokens: 0, total_tokens: billable, billable_tokens: billable, ...extra };
  return (await one<{ r: Record<string, unknown> }>("select quota_record_usage($1, $2, coalesce($3::timestamptz, now())) as r", [reservation, JSON.stringify(event), now ?? null])).r as {
    ok: boolean; duplicate?: boolean; used: number; reserved: number; remaining: number; overrun: number; crossed: number;
  };
}
async function settle(reservation: string) {
  return (await one<{ r: Record<string, unknown> }>("select quota_settle($1) as r", [reservation])).r as { settled: boolean; released: number };
}
async function audit() {
  return sql("select * from quota_audit()");
}

// ── tests ───────────────────────────────────────────────────────────────────

test("SQL period math agrees with the TypeScript mirror (month ends, leap years)", { skip }, async () => {
  const anchors = ["2026-01-31T10:30:00Z", "2028-01-31T00:00:00Z", "2028-02-29T12:00:00Z", "2026-12-31T23:59:59Z", "2026-10-17T06:00:00Z", "2026-03-30T00:00:00Z"];
  for (const a of anchors) {
    for (const n of [0, 1, 2, 3, 11, 12, 13, 25, 48]) {
      const row = await one<{ t: Date }>("select quota_add_months($1::timestamptz, $2) as t", [a, n]);
      assert.equal(row.t.toISOString(), addMonthsUtc(new Date(a), n).toISOString(), `${a} + ${n}`);
    }
  }
  const idx = await one<{ i: number }>("select quota_period_index('2026-01-31T00:00:00Z', '2026-03-30T23:59:59Z') as i");
  assert.equal(idx.i, 1); // Feb 28 → Mar 31 period
});

test("exact exhaustion: the last token can be spent, the next request is refused", { skip }, async () => {
  const user = await newUser("free");
  const first = await reserve(user, 1_000_000);
  assert.equal(first.ok, true);
  assert.equal(first.remaining, 0);
  const refused = await reserve(user, 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "exhausted");
  await record(first.id, 1_000_000);
  await settle(first.id);
  const after = await reserve(user, 1);
  assert.equal(after.ok, false);
  assert.equal(after.used, 1_000_000);
  assert.deepEqual(await audit(), []);
});

test("a request bigger than what's left is refused without touching the balance", { skip }, async () => {
  const user = await newUser("free");
  const r = await reserve(user, 999_500);
  await record(r.id, 999_500);
  await settle(r.id);
  const big = await reserve(user, 600);
  assert.equal(big.ok, false);
  assert.equal(big.reserved, 0);
  const fits = await reserve(user, 500);
  assert.equal(fits.ok, true);
});

test("concurrency: 60 simultaneous requests on 16 connections can't spend more than the allowance", { skip }, async () => {
  const user = await newUser("free");
  // 1,000,000 allowance, each request holds 50,000 → exactly 20 may succeed.
  const results = await Promise.all(Array.from({ length: 60 }, () => reserve(user, 50_000)));
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 20);
  const acc = await one<{ reserved: number; used: number }>("select reserved, used from quota_accounts where user_id = $1", [user]);
  assert.equal(acc.reserved, 1_000_000);
  // Every winner records its usage and settles, concurrently.
  await Promise.all(ok.map(async (r) => {
    await record(r.id, 40_000);
    await settle(r.id);
  }));
  const done = await one<{ reserved: number; used: number }>("select reserved, used from quota_accounts where user_id = $1", [user]);
  assert.deepEqual(done, { reserved: 0, used: 800_000 });
  assert.deepEqual(await audit(), []);
});

test("concurrent requests competing for the LAST tokens: exactly one wins", { skip }, async () => {
  const user = await newUser("free");
  const r = await reserve(user, 990_000);
  await record(r.id, 990_000);
  await settle(r.id);
  const race = await Promise.all(Array.from({ length: 30 }, () => reserve(user, 10_000)));
  assert.equal(race.filter((x) => x.ok).length, 1);
});

test("duplicate usage callbacks and retried settlements count once", { skip }, async () => {
  const user = await newUser("free");
  const r = await reserve(user, 5_000);
  const key = randomUUID();
  const results = await Promise.all([record(r.id, 3_000, key), record(r.id, 3_000, key), record(r.id, 3_000, key)]);
  assert.equal(results.filter((x) => x.duplicate).length, 2);
  const settles = await Promise.all([settle(r.id), settle(r.id)]);
  assert.equal(settles.filter((s) => s.settled).length, 1);
  const acc = await one<{ used: number; reserved: number }>("select used, reserved from quota_accounts where user_id = $1", [user]);
  assert.deepEqual(acc, { used: 3_000, reserved: 0 });
  const rows = await one<{ n: number }>("select count(*)::int n from token_ledger where reservation_id = $1", [r.id]);
  assert.equal(rows.n, 1);
  assert.deepEqual(await audit(), []);
});

test("replaying the same reservation id doesn't take a second hold", { skip }, async () => {
  const user = await newUser("free");
  const id = randomUUID();
  const call = () => one("select quota_reserve($1, $2, null, 100, $3) as r", [id, user, JSON.stringify(ALLOWANCES)]);
  await Promise.all([call(), call(), call()]).catch(() => undefined);
  const acc = await one<{ reserved: number }>("select reserved from quota_accounts where user_id = $1", [user]);
  assert.equal(acc.reserved, 100);
});

test("an overrun past the hold is recorded in full and blocks the next request", { skip }, async () => {
  const user = await newUser("free");
  const r = await reserve(user, 100_000);
  const res = await record(r.id, 1_100_000);
  assert.equal(res.ok, false);
  assert.equal(res.overrun, 100_000);
  const row = await one<{ overrun_tokens: number; billable_tokens: number }>("select overrun_tokens, billable_tokens from token_ledger where reservation_id = $1", [r.id]);
  assert.deepEqual(row, { overrun_tokens: 100_000, billable_tokens: 1_100_000 });
  await settle(r.id);
  assert.equal((await reserve(user, 1)).ok, false);
  assert.deepEqual(await audit(), []);
});

test("usage notices fire once per threshold per period", { skip }, async () => {
  const user = await newUser("free");
  const r = await reserve(user, 0);
  assert.equal((await record(r.id, 700_000)).crossed, 0);
  assert.equal((await record(r.id, 150_000)).crossed, 80);
  assert.equal((await record(r.id, 10_000)).crossed, 0);
  assert.equal((await record(r.id, 100_000)).crossed, 95);
  assert.equal((await record(r.id, 50_000)).crossed, 100);
  assert.equal((await record(r.id, 1)).crossed, 0);
});

test("monthly rollover: a new period starts from zero on the anchor date, not on the 1st", { skip }, async () => {
  const user = await newUser("free");
  const t0 = "2027-01-31T08:00:00Z";
  const r = await reserve(user, 0, t0);
  assert.equal(new Date(r.period_start).toISOString(), "2027-01-31T08:00:00.000Z");
  await record(r.id, 900_000, undefined, t0);
  await settle(r.id);
  assert.equal((await reserve(user, 200_000, "2027-02-28T07:59:59Z")).ok, false); // still January's period
  const feb = await reserve(user, 200_000, "2027-02-28T08:00:00Z");
  assert.equal(feb.ok, true);
  assert.equal(feb.used, 0);
  assert.equal(new Date(feb.period_end).toISOString(), "2027-03-31T08:00:00.000Z");
  // The rows of January keep their own period; the audit compares the current one only.
  assert.deepEqual(await audit(), []);
});

test("no daily cap: the whole monthly allowance can go in one day", { skip }, async () => {
  const user = await newUser("pro", new Date(Date.now() + 20 * 86_400_000).toISOString());
  for (let i = 0; i < 10; i++) {
    const r = await reserve(user, 1_000_000);
    assert.equal(r.ok, true, `request ${i}`);
    await record(r.id, 1_000_000);
    await settle(r.id);
  }
  assert.equal((await reserve(user, 1)).ok, false);
});

test("subscription lifecycle: subscribe, duplicate webhook, renewal, upgrade, queued downgrade, expiry", { skip }, async () => {
  const user = await newUser("free");
  const t = (iso: string) => iso;
  const pay = (plan: string, days: number, order: string, now: string) =>
    one<{ r: { applied: boolean; kind?: string; duplicate?: boolean } }>("select quota_apply_payment($1, $2, $3, $4, $5) as r", [user, plan, days, order, now]).then((x) => x.r);
  const profile = () => one<{ plan: string; plan_renews_at: Date | null }>("select plan, plan_renews_at from profiles where id = $1", [user]);

  // Free user spends some tokens, then subscribes to Pro: a fresh period with the full 10M.
  const f = await reserve(user, 0, t("2027-03-01T00:00:00Z"));
  await record(f.id, 400_000, undefined, t("2027-03-01T00:00:00Z"));
  assert.equal((await pay("pro", 30, "order_1", t("2027-03-10T00:00:00Z"))).kind, "subscribe");
  // Razorpay delivers the same webhook again (and once more concurrently).
  const dups = await Promise.all([pay("pro", 30, "order_1", t("2027-03-10T00:00:01Z")), pay("pro", 30, "order_1", t("2027-03-10T00:00:02Z"))]);
  assert.ok(dups.every((d) => d.duplicate));
  assert.equal((await profile()).plan_renews_at!.toISOString(), "2027-04-09T00:00:00.000Z");
  let r = await reserve(user, 0, t("2027-03-10T01:00:00Z"));
  assert.equal(r.allowance, 10_000_000);
  assert.equal(r.used, 0);
  await record(r.id, 6_000_000, undefined, t("2027-03-10T01:00:00Z"));

  // Early renewal: the term is extended from its end; the running period is NOT reset.
  assert.equal((await pay("pro", 30, "order_2", t("2027-03-20T00:00:00Z"))).kind, "renewal");
  assert.equal((await profile()).plan_renews_at!.toISOString(), "2027-05-09T00:00:00.000Z");
  r = await reserve(user, 0, t("2027-03-20T00:00:01Z"));
  assert.equal(r.used, 6_000_000);

  // Upgrade to Premium: new term from now, fresh period with 25M.
  assert.equal((await pay("premium", 30, "order_3", t("2027-03-25T00:00:00Z"))).kind, "upgrade");
  r = await reserve(user, 0, t("2027-03-25T00:00:01Z"));
  assert.equal(r.plan, "premium");
  assert.equal(r.allowance, 25_000_000);
  assert.equal(r.used, 0);

  // Buying Pro while Premium runs queues it for when Premium ends.
  assert.equal((await pay("pro", 30, "order_4", t("2027-04-01T00:00:00Z"))).kind, "downgrade_queued");
  assert.equal((await profile()).plan, "premium");
  // Premium ends 2027-04-24; the next request after that is on Pro, period anchored at the end.
  r = await reserve(user, 0, t("2027-04-30T00:00:00Z"));
  assert.equal(r.plan, "pro");
  assert.equal(new Date(r.period_start).toISOString(), "2027-04-24T00:00:00.000Z");
  assert.equal((await profile()).plan_renews_at!.toISOString(), "2027-05-24T00:00:00.000Z");

  // Nobody renews: after the Pro term the account is on Free, from the moment the term ended.
  r = await reserve(user, 0, t("2027-06-10T00:00:00Z"));
  assert.equal(r.plan, "free");
  assert.equal(r.allowance, 1_000_000);
  assert.equal(new Date(r.period_start).toISOString(), "2027-05-24T00:00:00.000Z");
  const events = await sql<{ kind: string }>("select kind from subscription_events where user_id = $1 order by created_at", [user]);
  assert.ok(events.some((e) => e.kind === "downgrade_applied") && events.some((e) => e.kind === "expired"));
});

test("annual plan: 12 monthly allowances, each renewing on the purchase date", { skip }, async () => {
  const user = await newUser("free");
  await one("select quota_apply_payment($1, 'pro', 365, 'order_annual', '2027-01-15T09:00:00Z')", [user]);
  for (const [now, start] of [["2027-01-20T00:00:00Z", "2027-01-15"], ["2027-02-20T00:00:00Z", "2027-02-15"], ["2027-12-20T00:00:00Z", "2027-12-15"]] as const) {
    const r = await reserve(user, 0, now);
    assert.equal(r.plan, "pro", now);
    assert.equal(r.used, 0, now);
    assert.equal(new Date(r.period_start).toISOString().slice(0, 10), start);
    await record(r.id, 9_000_000, undefined, now);
    await settle(r.id);
  }
  assert.equal((await reserve(user, 0, "2028-01-20T00:00:00Z")).plan, "free");
});

test("refunds take back the paid days once; tokens already used stay used", { skip }, async () => {
  const user = await newUser("free");
  const now = "2027-07-01T00:00:00Z";
  await one("select quota_apply_payment($1, 'pro', 30, 'order_r1', $2)", [user, now]);
  await one("select quota_apply_payment($1, 'pro', 30, 'order_r2', $2)", [user, now]); // renewal → 60 days
  const r = await reserve(user, 0, now);
  await record(r.id, 2_000_000, undefined, now);
  const refund = (order: string) => one<{ r: { kind?: string; duplicate?: boolean } }>("select quota_apply_refund($1, 'pro', 30, $2, $3) as r", [user, order, "2027-07-02T00:00:00Z"]).then((x) => x.r);
  assert.equal((await refund("order_r2")).kind, "term_shortened");
  assert.equal((await refund("order_r2")).duplicate, true);
  assert.equal((await refund("order_r1")).kind, "ended");
  const p = await one<{ plan: string }>("select plan from profiles where id = $1", [user]);
  assert.equal(p.plan, "free");
  const ledgerRows = await one<{ n: number }>("select coalesce(sum(billable_tokens),0)::int n from token_ledger where user_id = $1", [user]);
  assert.equal(ledgerRows.n, 2_000_000);
});

test("adjustments are append-only, idempotent and part of the balance", { skip }, async () => {
  const user = await newUser("free");
  const r = await reserve(user, 0);
  await record(r.id, 1_000_000);
  await settle(r.id);
  assert.equal((await reserve(user, 1)).ok, false);
  const acc = r.account_id;
  const bonus = () => one("select quota_adjust($1, -250000, 'bonus', 'goodwill', null, 'support-ticket-42')", [acc]);
  await Promise.all([bonus(), bonus()]);
  const after = await reserve(user, 250_000);
  assert.equal(after.ok, true);
  const n = await one<{ n: number }>("select count(*)::int n from quota_adjustments where account_id = $1", [acc]);
  assert.equal(n.n, 1);
  assert.deepEqual(await audit(), []);
});

test("a suspended account is blocked; usage history stays", { skip }, async () => {
  const user = await newUser("pro", new Date(Date.now() + 10 * 86_400_000).toISOString());
  const r = await reserve(user, 10);
  await record(r.id, 10);
  await settle(r.id);
  await sql("update quota_accounts set status = 'suspended' where user_id = $1", [user]);
  const blocked = await reserve(user, 1);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "suspended");
  await sql("update quota_accounts set status = 'active' where user_id = $1", [user]);
  assert.equal((await reserve(user, 1)).ok, true);
});

test("stale holds are released; live ones (recent heartbeat) are not", { skip }, async () => {
  const user = await newUser("free");
  const stale = await reserve(user, 300_000);
  const live = await reserve(user, 300_000);
  await sql("update quota_reservations set heartbeat_at = now() - interval '3 hours' where id = $1", [stale.id]);
  await record(live.id, 1); // heartbeat
  const released = await one<{ n: number }>("select quota_expire_stale_reservations('2 hours') as n");
  assert.equal(released.n, 1);
  const rows = await sql<{ id: string; status: string }>("select id, status from quota_reservations where account_id = $1", [stale.account_id]);
  assert.equal(rows.find((x) => x.id === stale.id)?.status, "expired");
  assert.equal(rows.find((x) => x.id === live.id)?.status, "active");
  assert.deepEqual(await audit(), []);
});

test("enterprise pool is shared by members, with an admin-set member cap", { skip }, async () => {
  const org = (await one<{ id: string }>("insert into organizations (plan, seat_count) values ('enterprise', 3) returning id")).id;
  const alice = await newUser("free", null, 1_000_000); // member cap 1M
  const bob = await newUser("free");
  const a = await reserve(alice, 900_000, undefined, org);
  assert.equal(a.allowance, 90_000_000);
  assert.equal((await reserve(alice, 200_000, undefined, org)).reason, "member_cap");
  const b = await reserve(bob, 5_000_000, undefined, org);
  assert.equal(b.ok, true);
  assert.equal(b.account_id, a.account_id);
  await record(a.id, 900_000);
  await settle(a.id);
  const member = await one<{ used: number; reserved: number }>("select used, reserved from quota_member_usage where user_id = $1", [alice]);
  assert.deepEqual(member, { used: 900_000, reserved: 0 });
  assert.deepEqual(await audit(), []);
});

test("service layer on real SQL: reserve → meter → settle, status, and two 'devices' sharing one balance", { skip }, async () => {
  const user = await newUser("pro", new Date(Date.now() + 25 * 86_400_000).toISOString());
  setPlanLookupForTests(async (): Promise<EffectivePlan> => {
    const p = await one<{ plan: "pro" }>("select plan from profiles where id = $1", [user]);
    return { plan: p.plan, planRenewsAt: null, customMonthlyCap: null, enterprise: null };
  });
  // Two sessions (web + a CLI token) at once — one shared allowance.
  const [web, cli] = await Promise.all([checkAndReserve(user, 2_000, { feature: "chat" }), checkAndReserve(user, 4_000, { feature: "code" })]);
  assert.ok(web.allowed && cli.allowed);
  const webMeter = new UsageMeter(web.reservation, { userId: user, feature: "chat" });
  const cliMeter = new UsageMeter(cli.reservation, { userId: user, feature: "code" });
  await webMeter.recordCall({ slug: "anthropic", modelId: "claude-sonnet-5" }, { promptTokens: 9_050, completionTokens: 300, totalTokens: 0, cachedTokens: 8_000, cacheWriteTokens: 1_000 });
  await cliMeter.recordCall({ slug: "gemini", modelId: "gemini-3-pro" }, usageFromGemini({ promptTokenCount: 1_000, candidatesTokenCount: 200, thoughtsTokenCount: 800 }));
  await Promise.all([webMeter.settle(), cliMeter.settle()]);
  const status = await getQuotaStatus(user);
  assert.equal(status.period.allowance, 10_000_000);
  assert.equal(status.period.used, 2_150 + 2_000);
  assert.equal(status.period.reserved, 0);
  assert.equal(status.period.remaining, 10_000_000 - 4_150);
  assert.equal(status.monthly?.used, 4_150);
  assert.equal(status.rolling, null);
  assert.equal(status.weekly, null);
  assert.deepEqual(await audit(), []);
});

/**
 * Reconciliation with known requests: provider usage payloads of every dialect go through the real
 * normalizers, the meter and the SQL; the ledger is then compared with hand-computed figures.
 */
test("reconciliation report: known requests → ledger totals match exactly", { skip }, async () => {
  const user = await newUser("premium", new Date(Date.now() + 25 * 86_400_000).toISOString());
  setPlanLookupForTests(async () => ({ plan: "premium", planRenewsAt: null, customMonthlyCap: null, enterprise: null }));
  const res = await checkAndReserve(user, 10_000, { feature: "chat" });
  assert.ok(res.allowed);
  const meter = new UsageMeter(res.reservation, { userId: user, feature: "chat" });
  const known: Array<{ name: string; model: { slug: string; modelId: string }; usage: TokenUsage; expected: number }> = [
    { name: "OpenAI plain", model: { slug: "openai", modelId: "gpt-5.6" }, usage: usageFromOpenAi({ prompt_tokens: 1_200, completion_tokens: 300 }), expected: 1_500 },
    { name: "OpenAI cached + reasoning", model: { slug: "openai", modelId: "o5" }, usage: usageFromOpenAi({ prompt_tokens: 20_000, completion_tokens: 2_000, prompt_tokens_details: { cached_tokens: 18_000 }, completion_tokens_details: { reasoning_tokens: 1_500 } }), expected: 2_000 + 2_000 + 1_800 },
    { name: "Anthropic cache read + write", model: { slug: "anthropic", modelId: "claude-opus-5" }, usage: { promptTokens: 50_100, completionTokens: 800, totalTokens: 0, cachedTokens: 45_000, cacheWriteTokens: 5_000 }, expected: 100 + 5_000 + 800 + 4_500 },
    { name: "Gemini thinking", model: { slug: "gemini", modelId: "gemini-3-pro" }, usage: usageFromGemini({ promptTokenCount: 3_000, candidatesTokenCount: 400, thoughtsTokenCount: 2_600, cachedContentTokenCount: 1_000 }), expected: 2_000 + 3_000 + 100 },
    { name: "No usage reported (estimated)", model: { slug: "sarvam", modelId: "sarvam-m" }, usage: { promptTokens: 1_000, completionTokens: 250, totalTokens: 1_250, estimated: true }, expected: 1_250 },
  ];
  const lines: string[] = [];
  for (const k of known) {
    assert.equal(billableTokens(k.usage), k.expected, k.name);
    await meter.recordCall(k.model, k.usage, { streaming: true });
    lines.push(`${k.name.padEnd(32)} in=${String(k.usage.promptTokens).padStart(6)} out=${String(k.usage.completionTokens).padStart(5)} cached=${String(k.usage.cachedTokens ?? 0).padStart(6)} reasoning=${String(k.usage.reasoningTokens ?? 0).padStart(5)} → billable ${k.expected}`);
  }
  // A retried delivery of the last call with the same key changes nothing.
  await meter.settle();
  const expectedTotal = known.reduce((n, k) => n + k.expected, 0);
  const ledger = await one<{ rows: number; billable: number; estimated: number }>(
    "select count(*)::int rows, sum(billable_tokens)::int billable, (sum(billable_tokens) filter (where usage_source = 'estimated'))::int estimated from token_ledger where reservation_id = $1",
    [res.reservation.id],
  );
  const account = await one<{ used: number; reserved: number }>("select used, reserved from quota_accounts where id = $1", [res.reservation.accountId]);
  console.log(`\n  Reconciliation (known requests)\n  ${lines.join("\n  ")}\n  expected ${expectedTotal} · ledger ${ledger.billable} (${ledger.rows} rows, ${ledger.estimated} estimated) · account.used ${account.used} · reserved ${account.reserved} · audit ${JSON.stringify(await audit())}\n`);
  assert.equal(ledger.rows, known.length);
  assert.equal(ledger.billable, expectedTotal);
  assert.equal(account.used, expectedTotal);
  assert.equal(ledger.estimated, 1_250);
  assert.equal(account.reserved, 0);
  assert.deepEqual(await audit(), []);
});
