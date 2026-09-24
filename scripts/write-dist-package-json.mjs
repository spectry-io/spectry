import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The root package.json says `"type": "module"`, which makes every .js file in
 * the tree an ES module — including the CommonJS build, which then fails to
 * load under `require()`. Dropping a two-line package.json into each output
 * directory overrides that per-folder.
 *
 * This is the standard fix for shipping both builds from one `"type": "module"`
 * package; without it, `require("@spectry/spectry")` throws
 * ERR_REQUIRE_ESM even though the CJS files are perfectly valid.
 */
const targets = [
  ["dist/cjs", { type: "commonjs" }],
  ["dist/esm", { type: "module" }],
];

for (const [dir, contents] of targets) {
  if (!existsSync(dir)) {
    console.error(`[build] expected ${dir} to exist — run the tsc builds first`);
    process.exit(1);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(contents, null, 2) + "\n");
  console.log(`[build] wrote ${dir}/package.json (${contents.type})`);
}
