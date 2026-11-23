import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildDuplicationPreview } from "../dist/core/previews.js";

test("buildDuplicationPreview prints each group's code once and other copies as ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "sonar-dup-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "alpha\nbeta\ngamma\n", "utf8");
  await writeFile(join(root, "src/b.ts"), "x\nalpha\nbeta\ngamma\n", "utf8");
  const text = await buildDuplicationPreview(root, "src/a.ts", [
    {
      blocks: [
        { from: 1, size: 3, filePath: "src/a.ts" },
        { from: 2, size: 3, filePath: "src/b.ts" },
      ],
    },
  ]);
  assert.equal(text.match(/beta/g).length, 1);
  assert.match(text, /src\/a\.ts:1-3/);
  assert.match(text, /src\/b\.ts:2-4/);
});

test("buildDuplicationPreview falls back to next readable copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "sonar-dup-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/b.ts"), "one\ntwo\n", "utf8");
  const text = await buildDuplicationPreview(root, "src/a.ts", [
    {
      blocks: [
        { from: 1, size: 2, filePath: "src/a.ts" },
        { from: 1, size: 2, filePath: "src/b.ts" },
      ],
    },
  ]);
  assert.match(text, /1 \| one/);
  assert.equal(text.match(/two/g).length, 1);
  const none = await buildDuplicationPreview(root, "src/a.ts", [
    { blocks: [{ from: 1, size: 2, filePath: "src/zz.ts" }] },
  ]);
  assert.match(none, /unable to read/);
});

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
