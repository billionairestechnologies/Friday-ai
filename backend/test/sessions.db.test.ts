import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration 0068 (sessions & devices) on a real Postgres, with a stand-in auth.sessions table:
 *   QUOTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm test
 * Skipped without it (CI has no Postgres).
 */
const ADMIN_URL = process.env.QUOTA_TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !ADMIN_URL ? "set QUOTA_TEST_DATABASE_URL to run the Postgres sessions tests" : false;

type Pool = import("pg").Pool;
let admin: Pool;
let pool: Pool;
let dbName = "";
let alice = "";

before(async () => {
  if (!ADMIN_URL) return;
  const pg = (await import("pg")).default;
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  dbName = `sess_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
  await pool.query(`
    create table public.profiles (id uuid primary key default gen_random_uuid());
    create schema auth;
    create table auth.sessions (id uuid primary key, user_id uuid);`);
  alice = (await pool.query("insert into profiles default values returning id")).rows[0].id;
  await pool.query(await readFile(path.join(here, "../../supabase/migrations/0068_user_sessions.sql"), "utf8"));
});

after(async () => {
  if (!ADMIN_URL) return;
  await pool.end();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

const signIn = async (max = 0) => {
  const id = randomUUID();
  await pool.query("insert into auth.sessions (id, user_id) values ($1, $2)", [id, alice]);
  const r = await pool.query("select session_touch($1, $2, 'web', 'Chrome on macOS', '1.2.3.x', $3) as s", [id, alice, max]);
  assert.equal(r.rows[0].s, "ok");
  return id;
};
const list = async () => (await pool.query("select id from session_list($1)", [alice])).rows.map((r) => r.id as string);

test("sessions are listed while their auth session exists; a normal sign-out drops them", { skip }, async () => {
  const a = await signIn();
  assert.ok((await list()).includes(a));
  await pool.query("delete from auth.sessions where id = $1", [a]);
  assert.ok(!(await list()).includes(a));
});

test("revoking ends the auth session too, and the next touch says revoked", { skip }, async () => {
  const s = await signIn();
  assert.equal((await pool.query("select session_revoke($1, 'user') as r", [s])).rows[0].r, true);
  assert.equal((await pool.query("select count(*)::int as n from auth.sessions where id = $1", [s])).rows[0].n, 0);
  assert.equal((await pool.query("select session_touch($1, $2, 'web', '', null, 0) as s", [s, alice])).rows[0].s, "revoked");
  assert.equal((await pool.query("select session_revoke($1, 'user') as r", [s])).rows[0].r, false, "idempotent");
});

test("a session id presented by another person is refused", { skip }, async () => {
  const s = await signIn();
  const bob = (await pool.query("insert into profiles default values returning id")).rows[0].id;
  assert.equal((await pool.query("select session_touch($1, $2, 'web', '', null, 0) as s", [s, bob])).rows[0].s, "revoked");
});

test("device limit: a new sign-in over the limit signs out the least-recently-used ones", { skip }, async () => {
  await pool.query("update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [alice]);
  const first = await signIn(2);
  const second = await signIn(2);
  await pool.query("update user_sessions set last_seen_at = now() - interval '1 hour' where id = $1", [first]);
  const third = await signIn(2);
  const active = await list();
  assert.deepEqual(new Set(active), new Set([second, third]));
  const reason = (await pool.query("select revoked_reason from user_sessions where id = $1", [first])).rows[0].revoked_reason;
  assert.equal(reason, "device_limit");
});

test("limit 0 means no limit; simultaneous sign-ins can't both slip under a limit", { skip }, async () => {
  await pool.query("update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [alice]);
  for (let i = 0; i < 5; i++) await signIn(0);
  assert.equal((await list()).length, 5);
  await pool.query("update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [alice]);
  const ids = Array.from({ length: 4 }, () => randomUUID());
  for (const id of ids) await pool.query("insert into auth.sessions (id, user_id) values ($1, $2)", [id, alice]);
  await Promise.all(ids.map((id) => pool.query("select session_touch($1, $2, 'android', '', null, 1)", [id, alice])));
  assert.equal((await list()).length, 1);
});
