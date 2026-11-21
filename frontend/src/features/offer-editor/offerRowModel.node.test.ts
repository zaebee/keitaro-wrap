import test from "node:test";
import assert from "node:assert/strict";

import {
  computeActionMenuPlacement,
  describeOfferStatus,
  describeShareEditState,
} from "./offerRowModel";

test("describeShareEditState distinguishes unmodified vs staged vs typed share input", () => {
  const clean = describeShareEditState({
    offerShare: 45,
    baselineShare: 45,
    draftInput: "",
  });
  assert.equal(clean.currentPercentLabel, "45%");
  assert.equal(clean.baselinePercentLabel, null);
  assert.equal(clean.shareModified, false);
  assert.equal(clean.hasPendingInput, false);
  assert.equal(clean.inputDiffersFromCurrent, false);

  const sameTyped = describeShareEditState({
    offerShare: 45,
    baselineShare: 45,
    draftInput: "45",
  });
  assert.equal(sameTyped.hasPendingInput, true);
  assert.equal(sameTyped.inputDiffersFromCurrent, false);

  const dirtyTyped = describeShareEditState({
    offerShare: 45,
    baselineShare: 60,
    draftInput: "30",
  });
  assert.equal(dirtyTyped.shareModified, true);
  assert.equal(dirtyTyped.baselinePercentLabel, "60%");
  assert.equal(dirtyTyped.inputDiffersFromCurrent, true);
  assert.match(dirtyTyped.submitTitle, /Apply 30% share/);
});

test("describeOfferStatus separates local lifecycle from non-active Keitaro state", () => {
  assert.deepEqual(
    describeOfferStatus({ lifecycle: "ACTIVE", remoteState: "active" }),
    { primaryLabel: "Active", remoteBadgeLabel: null },
  );
  assert.deepEqual(
    describeOfferStatus({ lifecycle: "ACTIVE", remoteState: null }),
    { primaryLabel: "Active", remoteBadgeLabel: null },
  );
  assert.deepEqual(
    describeOfferStatus({ lifecycle: "ARCHIVED", remoteState: "disabled" }),
    { primaryLabel: "Archived", remoteBadgeLabel: "Keitaro: disabled" },
  );
});

test("computeActionMenuPlacement uses absolute fallback in jsdom and fixed positioning in browser", () => {
  assert.deepEqual(
    computeActionMenuPlacement(
      { top: 0, bottom: 0, right: 0, width: 0, height: 0 },
      { width: 1440, height: 900 },
    ),
    { mode: "absolute" },
  );

  const down = computeActionMenuPlacement(
    { top: 300, bottom: 330, right: 1000, width: 30, height: 30 },
    { width: 1440, height: 900 },
  );
  assert.deepEqual(down, {
    mode: "fixed",
    direction: "down",
    top: 336,
    right: 440,
  });

  const up = computeActionMenuPlacement(
    { top: 830, bottom: 860, right: 1438, width: 30, height: 30 },
    { width: 1440, height: 900 },
    104,
  );
  assert.deepEqual(up, {
    mode: "fixed",
    direction: "up",
    bottom: 76,
    right: 8,
  });
});
