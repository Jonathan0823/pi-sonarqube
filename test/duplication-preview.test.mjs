import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildDuplicationPreview } from "../dist/ui.js";

test("buildDuplicationPreview renders exact duplicated lines only", async () => {
  const root = await mkdtemp(join(tmpdir(), "sonar-dup-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/file.ts"), "one\ntwo\nthree\nfour\n", "utf8");

  const text = await buildDuplicationPreview(root, "src/file.ts", [
    { blocks: [{ from: 2, size: 2, filePath: "src/file.ts" }] },
  ]);

  assert.match(text, /src\/file\.ts:2-3/);
  assert.match(text, /2 \| two/);
  assert.match(text, /3 \| three/);
  assert.doesNotMatch(text, /1 \| one/);
});
