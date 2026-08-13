#!/usr/bin/env node
// Ledger well-formedness gate. The loop protocol in plans/LOOP.md picks "the FIRST
// task with status TODO", so a corrupt ledger silently sends a weak model into a
// re-do loop. This fails the build instead.
import { readFileSync } from "node:fs";

const STATUSES = new Set(["TODO", "DOING", "DONE", "BLOCKED", "NEEDS-SPEC"]);
const path = process.argv[2] ?? "plans/STATE.md";
const text = readFileSync(path, "utf8");

const rows = [];
for (const line of text.split("\n")) {
  const m = /^\|\s*(T-P[0-9]+-[0-9]+)\s*\|(.*)$/.exec(line);
  if (!m) continue;
  const cells = m[2].split("|").map((c) => c.trim());
  rows.push({ id: m[1], subject: cells[0], deps: cells[1], status: cells[2] });
}

const errors = [];
if (rows.length === 0) errors.push(`no task rows parsed from ${path}`);

const seen = new Map();
for (const r of rows) {
  if (seen.has(r.id)) {
    errors.push(`duplicate id ${r.id} (status ${seen.get(r.id)} and ${r.status})`);
  }
  seen.set(r.id, r.status);
  if (!STATUSES.has(r.status)) {
    errors.push(`${r.id}: unknown status "${r.status}"`);
  }
}

const doing = rows.filter((r) => r.status === "DOING");
if (doing.length > 1) {
  errors.push(`${doing.length} rows are DOING (max 1): ${doing.map((r) => r.id).join(", ")}`);
}

// deps must reference real ids and must be DONE before a row can be DONE
for (const r of rows) {
  if (!r.deps || r.deps === "-") continue;
  for (const dep of r.deps.split(/[,\s]+/).filter(Boolean)) {
    if (!seen.has(dep)) {
      errors.push(`${r.id}: dep ${dep} does not exist`);
    } else if (r.status === "DONE" && seen.get(dep) !== "DONE") {
      errors.push(`${r.id} is DONE but dep ${dep} is ${seen.get(dep)}`);
    }
  }
}

const next = /^next:\s*(\S+)/m.exec(text)?.[1];
if (next && next !== "-") {
  if (!seen.has(next)) errors.push(`next: ${next} does not exist`);
  else if (seen.get(next) === "DONE") errors.push(`next: ${next} is already DONE`);
}

if (errors.length) {
  console.error(`${path}: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const counts = {};
for (const s of seen.values()) counts[s] = (counts[s] ?? 0) + 1;
console.log(
  `${path}: ok — ${seen.size} tasks (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})`,
);
