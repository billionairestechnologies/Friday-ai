import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const migrationsDir = path.resolve("supabase/migrations");
const files = (await readdir(migrationsDir))
  .filter((file) => file.endsWith(".sql"))
  .sort();

const errors = [];
let previous = 0;

for (const file of files) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
  if (!match) {
    errors.push(`${file}: migration name must be NNNN_descriptive_name.sql`);
    continue;
  }

  const number = Number(match[1]);
  if (number !== previous + 1) {
    errors.push(`${file}: expected migration ${String(previous + 1).padStart(4, "0")}`);
  }
  previous = number;

  const sql = await readFile(path.join(migrationsDir, file), "utf8");
  if (/\bdrop\s+(table|schema|database)\b/i.test(sql) && !/allow-destructive-migration/i.test(sql)) {
    errors.push(`${file}: destructive drops need an allow-destructive-migration comment`);
  }
}

if (files.length === 0) {
  errors.push("No migrations found");
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Verified ${files.length} migration${files.length === 1 ? "" : "s"}.`);
