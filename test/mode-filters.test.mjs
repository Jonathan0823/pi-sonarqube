import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertFiltersNotAmbiguous,
  fetchCleanCodeMode,
  issueFilterLabel,
  parseIssueFilterToken,
} from "../dist/api.js";
import { formatMetricsOutput } from "../dist/commands.js";

test("fetchCleanCodeMode caches by server URL", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ mode: "MQR" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
  assert.deepEqual(parseIssueFilterToken("quality:SECURITY"), { softwareQualities: ["SECURITY"] });
  assert.deepEqual(parseIssueFilterToken("impactSeverity:HIGH"), { impactSeverities: ["HIGH"] });
  assert.doesNotThrow(() => assertFiltersNotAmbiguous({ severities: ["CRITICAL"] }));
  assert.throws(() =>
    assertFiltersNotAmbiguous({ severities: ["CRITICAL"], softwareQualities: ["SECURITY"] }),
  );
});

test("formats metrics with both severity and quality counts", () => {
  const text = formatMetricsOutput({
    projectKey: "demo",
    issueCounts: { blocker: 1, critical: 2, major: 3, minor: 4, info: 5 },
    issueQualityCounts: { maintainability: 6, reliability: 7, security: 8 },
  });

  assert.match(text, /Issues:\s+BLOCKER 1/);
  assert.match(text, /Quality:\s+MAINTAINABILITY 6/);
  assert.match(issueFilterLabel({ softwareQualities: ["SECURITY"], impactSeverities: ["HIGH"] }), /qualities=SECURITY/);
});
