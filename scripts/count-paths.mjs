import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const path = fileURLToPath(new URL("../openapi/ori-v1.yaml", import.meta.url));
const doc = yaml.load(readFileSync(path, "utf8"));

const paths = Object.keys(doc.paths);
let operations = 0;
for (const p of paths) {
  for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
    if (doc.paths[p][m]) operations++;
  }
}
console.log(`paths=${paths.length} operations=${operations}`);
const PASS = paths.length === 25 ? 0 : 1;
process.exit(PASS);