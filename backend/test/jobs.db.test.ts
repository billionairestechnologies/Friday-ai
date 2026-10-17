import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Migration 0066 job queue on a real Postgres (QUOTA_TEST_DATABASE_URL); skipped without it. */
const ADMIN_URL = process.env.QUOTA_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !ADMIN_URL ? "set QUOTA_TEST_DATABASE_URL to run the Postgres job tests" : false;
type Pool = import("pg").Pool;
let admin: Pool;
let pool: Pool;
let dbName = "";

before(async () => {
  if (!ADMIN_URL) return;
  const pg = (await import("pg")).default;
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `jobs_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 12 });
  await pool.query("create table public.credit_settings (id boolean primary key default true)");
  const sql = await readFile(path.join(here, "../../supabase/migrations/0066_credit_value_and_jobs.sql"), "utf8");
  await pool.query(sql);
  await pool.query(sql);
});
after(async () => {
  if (!ADMIN_URL) return;
  await pool.end();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

const enqueue = async (kind: string, tenant: string | null, extra = "") =>
  (await pool.query(`insert into jobs (kind, tenant${extra ? ", max_attempts" : ""}) values ($1, $2${extra ? `, ${extra}` : ""}) returning id`, [kind, tenant])).rows[0].id as string;
const claim = async (worker: string, n = 10) => (await pool.query("select * from job_claim($1, $2, 30)", [worker, n])).rows as Array<{ id: string; tenant: string; attempts: number }>;

test("eight workers racing claim each job exactly once", { skip }, async () => {
  for (let i = 0; i < 20; i++) await enqueue("race", null);
  const got = (await Promise.all(Array.from({ length: 8 }, (_, w) => claim(`w${w}`, 5)))).flat();
  assert.equal(got.length, new Set(got.map((j) => j.id)).size, "no job claimed twice");
  assert.equal(got.length, 20);
  await pool.query("update jobs set status = 'succeeded' where kind = 'race'");
});

test("fairness: one running job per tenant; a busy tenant can't starve others", { skip }, async () => {
  for (let i = 0; i < 5; i++) await enqueue("bulk", "big-customer");
  await enqueue("bulk", "small-a");
  await enqueue("bulk", "small-b");
  const first = await claim("w1");
  assert.deepEqual(first.map((j) => j.tenant).sort(), ["big-customer", "small-a", "small-b"]);
  assert.equal((await claim("w2")).length, 0, "big-customer waits for its running job");
  await pool.query("select job_complete($1, 'w1', '{}')", [first.find((j) => j.tenant === "big-customer")!.id]);
  assert.equal((await claim("w2")).map((j) => j.tenant).join(), "big-customer", "then its next job runs");
  await pool.query("update jobs set status = 'succeeded' where kind = 'bulk'");
});

test("failures back off, then dead-letter; non-retryable dies at once", { skip }, async () => {
  const id = await enqueue("flaky", "t1", "2");
  const [j] = await claim("w1");
  assert.equal(j!.id, id);
  assert.equal((await pool.query("select job_fail($1, 'w1', 'boom', true) as r", [id])).rows[0].r, "retry");
  const row = (await pool.query("select status, run_after > now() + interval '5 seconds' as later from jobs where id = $1", [id])).rows[0];
  assert.deepEqual(row, { status: "queued", later: true });
  await pool.query("update jobs set run_after = now() where id = $1", [id]);
  await claim("w1");
  assert.equal((await pool.query("select job_fail($1, 'w1', 'boom again', true) as r", [id])).rows[0].r, "dead");
  const bad = await enqueue("bad", "t2");
  await claim("w1");
  assert.equal((await pool.query("select job_fail($1, 'w1', 'invalid payload', false) as r", [bad])).rows[0].r, "dead");
});

test("a dead worker's job is recovered; the old worker can't complete it afterwards", { skip }, async () => {
  const id = await enqueue("lease", "t3");
  await claim("old-worker");
  await pool.query("update jobs set lease_until = now() - interval '1 second' where id = $1", [id]);
  assert.equal((await pool.query("select job_recover() as n")).rows[0].n, 1);
  const [again] = await claim("new-worker");
  assert.equal(again!.id, id);
  assert.equal(again!.attempts, 2);
  assert.equal((await pool.query("select job_complete($1, 'old-worker', '{}') as ok", [id])).rows[0].ok, null, "fenced: stale worker loses");
  assert.equal((await pool.query("select job_complete($1, 'new-worker', '{\"n\":1}') as ok", [id])).rows[0].ok, true);
});

test("an idempotency key enqueues once", { skip }, async () => {
  await pool.query("insert into jobs (kind, idempotency_key) values ('x', 'k1')");
  await assert.rejects(pool.query("insert into jobs (kind, idempotency_key) values ('x', 'k1')"), /idempotency_key/);
});
