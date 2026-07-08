import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertFiltersNotAmbiguous,
  fetchCleanCodeMode,
  fetchFileDuplications,
  fetchIssueSeverityCounts,
  issueFilterLabel,
  parseIssueFilterToken,
} from "../dist/api.js";
import { formatMetricsOutput, sonarArgumentCompletions } from "../dist/commands.js";

function mockResponse(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    },
    async text() {
      return text;
    },
  };
}

test("fetchCleanCodeMode caches by server URL", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return mockResponse({ mode: "MQR" });
    };

    const first = await fetchCleanCodeMode("http://example.test", "token");
    const second = await fetchCleanCodeMode("http://example.test", "token");

    assert.equal(first, "MQR");
    assert.equal(second, "MQR");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parses MQR filters and rejects mixed families", () => {
  assert.deepEqual(parseIssueFilterToken("quality:SECURITY"), {
    softwareQualities: ["SECURITY"],
  });
  assert.deepEqual(parseIssueFilterToken("impactSeverity:HIGH"), {
    impactSeverities: ["HIGH"],
  });
  assert.doesNotThrow(() =>
    assertFiltersNotAmbiguous({ severities: ["CRITICAL"] }),
  );
  assert.throws(() =>
    assertFiltersNotAmbiguous({
      severities: ["CRITICAL"],
      softwareQualities: ["SECURITY"],
    }),
  );
});

test("issue autocomplete includes rule filter keys", () => {
  const items = sonarArgumentCompletions("issues ru") ?? [];
  const values = items.map((item) => item.value);

  assert.ok(values.includes("rule:"));
  assert.ok(values.includes("rules:"));
});

test("formats metrics with standard severity labels", () => {
  const text = formatMetricsOutput({
    projectKey: "demo",
    issueCounts: { blocker: 1, critical: 2, major: 3, minor: 4, info: 5 },
    issueQualityCounts: { maintainability: 6, reliability: 7, security: 8 },
  });

  assert.match(text, /Issues:\s+BLOCKER 1/);
  assert.match(text, /CRITICAL 2/);
  assert.match(text, /Quality:\s+MAINTAINABILITY 6/);
  assert.match(
    issueFilterLabel({
      softwareQualities: ["SECURITY"],
      impactSeverities: ["HIGH"],
    }),
    /qualities=SECURITY/,
  );
});

test("formats metrics with MQR severity labels", () => {
  const text = formatMetricsOutput({
    projectKey: "demo",
    cleanCodeMode: "MQR",
    issueCounts: { blocker: 1, critical: 2, major: 3, minor: 4, info: 5 },
  });

  assert.match(
    text,
    /Issues:\s+BLOCKER 1\s+HIGH 2\s+MEDIUM 3\s+LOW 4\s+INFO 5/,
  );
});

test("formats coverage line when coverage data is present", () => {
  const text = formatMetricsOutput({
    projectKey: "demo",
    measures: {
      duplicatedLinesDensity: 5.2,
      duplicatedLines: 10,
      duplicatedBlocks: 3,
      duplicatedFiles: 2,
      coverage: 15.5,
      linesToCover: 200,
      uncoveredLines: 169,
    },
  });

  assert.match(text, /Coverage: 15\.5%  covered=31  uncovered=169  lines=200/);
  assert.match(text, /Duplication: 5\.2%/);
  assert.match(text, /blocks=3/);
});

test("formats coverage n/a when coverage data is absent", () => {
  const text = formatMetricsOutput({
    projectKey: "demo",
    measures: {
      duplicatedLinesDensity: 0,
      duplicatedLines: 0,
      duplicatedBlocks: 0,
      duplicatedFiles: 0,
    },
  });

  assert.match(text, /Coverage: n\/a/);
  assert.match(text, /Duplication: 0\.0%/);
});

test("fetchIssueSeverityCounts uses impact severities in MQR mode", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  try {
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return mockResponse({
        facets: [
          {
            property: "impactSeverities",
            values: [
              { val: "BLOCKER", count: 1 },
              { val: "HIGH", count: 2 },
              { val: "MEDIUM", count: 3 },
              { val: "LOW", count: 4 },
              { val: "INFO", count: 5 },
            ],
          },
        ],
      });
    };

    const counts = await fetchIssueSeverityCounts(
      "http://example.test",
      "token",
      "demo",
      undefined,
      "MQR",
    );

    assert.match(requestedUrl, /facets=impactSeverities/);
    assert.deepEqual(counts, {
      blocker: 1,
      critical: 2,
      major: 3,
      minor: 4,
      info: 5,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("file duplication fetch surfaces permission errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      mockResponse({ errors: [{ msg: "Insufficient privileges" }] }, 403);

    await assert.rejects(
      () =>
        fetchFileDuplications(
          "http://example.test",
          "token",
          "demo",
          undefined,
        ),
      /403|Insufficient privileges/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("file duplication fetch sorts by duplicated lines density", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  try {
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return mockResponse({
        components: [
          {
            key: "demo:a",
            path: "src/a.ts",
            measures: [
              { metric: "duplicated_blocks", value: "1" },
              { metric: "duplicated_lines", value: "10" },
              { metric: "duplicated_lines_density", value: "2.5" },
            ],
          },
          {
            key: "demo:b",
            path: "src/b.ts",
            measures: [
              { metric: "duplicated_blocks", value: "2" },
              { metric: "duplicated_lines", value: "20" },
              { metric: "duplicated_lines_density", value: "8.0" },
            ],
          },
          {
            key: "demo:c",
            path: "src/c.ts",
            measures: [
              { metric: "duplicated_blocks", value: "3" },
              { metric: "duplicated_lines", value: "15" },
              { metric: "duplicated_lines_density", value: "5.0" },
            ],
          },
        ],
      });
    };

    const files = await fetchFileDuplications(
      "http://example.test",
      "token",
      "demo",
      undefined,
    );

    assert.match(requestedUrl, /duplicated_lines_density/);
    assert.deepEqual(
      files.map((file) => file.filePath),
      ["src/b.ts", "src/c.ts", "src/a.ts"],
    );
    assert.deepEqual(
      files.map((file) => file.duplicatedLinesDensity),
      [8, 5, 2.5],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
