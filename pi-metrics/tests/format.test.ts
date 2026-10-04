import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatCost,
  formatDuration,
  formatTokens,
  renderFormat,
  renderMetrics,
} from "../src/format.ts";

describe("formatDuration", () => {
  test("renders sub-minute durations with one decimal", () => {
    assert.equal(formatDuration(2_000), "2.0s");
    assert.equal(formatDuration(400), "0.4s");
    assert.equal(formatDuration(59_700), "59.7s");
  });

  test("renders minutes and seconds", () => {
    assert.equal(formatDuration(79_100), "1m 19.1s");
  });

  test("renders hours and minutes", () => {
    assert.equal(formatDuration(4_320_000), "1h 12m");
  });
});

describe("formatTokens", () => {
  test("keeps counts under one thousand as-is", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
  });

  test("scales thousands and drops a trailing .0", () => {
    assert.equal(formatTokens(1_000), "1K");
    assert.equal(formatTokens(1_234), "1.2K");
    assert.equal(formatTokens(12_200), "12.2K");
  });

  test("scales millions", () => {
    assert.equal(formatTokens(1_000_000), "1M");
    assert.equal(formatTokens(1_200_000), "1.2M");
  });

  test("promotes counts that would round to 1000K", () => {
    assert.equal(formatTokens(999_949), "999.9K");
    assert.equal(formatTokens(999_950), "1M");
    assert.equal(formatTokens(999_999), "1M");
  });
});

describe("renderFormat", () => {
  test("substitutes known placeholders", () => {
    const rendered = renderFormat("Worked for {elapsed} · TPS {tps} tok/s", {
      elapsed: "1m 19.1s",
      tps: "227.8",
      ttft: "2.0s",
      input: "12.2K",
      output: "1.7K",
    });
    assert.equal(rendered, "Worked for 1m 19.1s · TPS 227.8 tok/s");
  });

  test("replaces every occurrence of a repeated placeholder", () => {
    const rendered = renderFormat("{input} → {output} ({input})", {
      elapsed: "1.0s",
      tps: "1.0",
      ttft: "1.0s",
      input: "10",
      output: "20",
    });
    assert.equal(rendered, "10 → 20 (10)");
  });

  test("keeps unknown placeholders untouched", () => {
    const rendered = renderFormat("{elapsed} {foo} {bar}", {
      elapsed: "23.1s",
      tps: "1.0",
      ttft: "1.0s",
      input: "1",
      output: "1",
    });
    assert.equal(rendered, "23.1s {foo} {bar}");
  });
});

describe("formatCost", () => {
  test("renders US dollars with six decimals", () => {
    assert.equal(formatCost(1.234567), "$1.234567");
    assert.equal(formatCost(1.234), "$1.234000");
    assert.equal(formatCost(0.5), "$0.500000");
    assert.equal(formatCost(42), "$42.000000");
  });

  test("keeps a sub-cent cost visible", () => {
    assert.equal(formatCost(0.004), "$0.004000");
  });

  test("keeps a positive cost below the displayed precision visible", () => {
    assert.equal(formatCost(0.0000004), "$0.000000");
  });
});

describe("renderMetrics", () => {
  test("renders the default line", () => {
    const rendered = renderMetrics(
      "Worked for {elapsed} · TPS {tps} tok/s · TTFT {ttft} · in {input} · out {output}",
      {
        elapsedMs: 79_100,
        tps: 227.8,
        ttftMs: 2_000,
        inputTokens: 12_200,
        outputTokens: 1_700,
        costUsd: 0,
      },
    );
    assert.equal(
      rendered,
      "Worked for 1m 19.1s · TPS 227.8 tok/s · TTFT 2.0s · in 12.2K · out 1.7K",
    );
  });

  test("appends a cost segment when the provider reported a cost", () => {
    const rendered = renderMetrics(
      "Worked for {elapsed} · in {input} · out {output}",
      {
        elapsedMs: 79_100,
        tps: null,
        ttftMs: null,
        inputTokens: 12_200,
        outputTokens: 1_700,
        costUsd: 1.234567,
      },
    );
    assert.equal(
      rendered,
      "Worked for 1m 19.1s · in 12.2K · out 1.7K · cost $1.234567",
    );
  });

  test("appends a cost segment for a positive cost below the displayed precision", () => {
    const rendered = renderMetrics("{input}", {
      elapsedMs: 1_000,
      tps: null,
      ttftMs: null,
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.0000004,
    });
    assert.equal(rendered, "10 · cost $0.000000");
  });

  test("omits the cost segment for a zero cost", () => {
    const rendered = renderMetrics("{input}", {
      elapsedMs: 1_000,
      tps: null,
      ttftMs: null,
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0,
    });
    assert.equal(rendered, "10");
  });

  test("marks an estimated tps with a leading approx sign", () => {
    const rendered = renderMetrics("{tps}", {
      elapsedMs: 1_000,
      tps: 66.7,
      tpsEstimated: true,
      ttftMs: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    assert.equal(rendered, "≈66.7");
  });

  test("uses n/a for unmeasurable tps and ttft", () => {
    const rendered = renderMetrics(
      "Worked for {elapsed} · TPS {tps} tok/s · TTFT {ttft} · in {input} · out {output}",
      {
        elapsedMs: 300,
        tps: null,
        ttftMs: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
    );
    assert.equal(
      rendered,
      "Worked for 0.3s · TPS n/a tok/s · TTFT n/a · in 0 · out 0",
    );
  });
});
