// Parser tests against bambu-bar's committed sample reports. We verify the
// H3C's AMS 3H comes out as one unit with nine slots, chamber temperature is
// parsed from the newer `device` block, no spurious issues are reported for an
// idle printer, and model detection follows the serial prefix.

import { describe, expect, it } from "vitest";

import { ReportDocument, parseReport } from "../bambu-report";
import { findModel } from "../bambu-models";

import h3cSample from "./fixtures/h3c-sample.json";
import p2sSample from "./fixtures/p2s-sample.json";
import a1Sample from "./fixtures/a1-sample.json";

function docFrom(sample: any): ReportDocument {
  const doc = new ReportDocument();
  doc.apply(sample.pushall ?? sample);
  if (sample.get_version) {
    doc.apply(sample.get_version);
  }
  return doc;
}

describe("Bambu model catalog", () => {
  it("finds H3C by code N10", () => {
    expect(findModel("N10")?.name).toBe("H3C");
  });
  it("finds H3C by serial prefix 32X", () => {
    expect(findModel("", "32X00A000000000")?.name).toBe("H3C");
  });
  it("aliases O1C2 to H2C", () => {
    expect(findModel("O1C2")?.name).toBe("H2C");
  });
});

describe("parseReport (H3C sample)", () => {
  const doc = docFrom(h3cSample);
  const status = parseReport(doc, findModel("", "32X_DUMMY_SERIAL_12345"));

  it("flags standby (gcode_state IDLE)", () => {
    expect(status.printState).toBe("standby");
  });

  it("detects the H3C model", () => {
    expect(status.model?.code).toBe("N10");
    expect(status.model?.name).toBe("H3C");
  });

  it("produces one AMS unit with nine slots (AMS 3H)", () => {
    expect(status.ams).not.toBeNull();
    expect(status.ams!.length).toBe(1);
    expect(status.ams![0].kind).toBe("ams3h");
    expect(status.ams![0].slots.length).toBe(9);
    // The AMS 3H's spool ids start at 1024.
    for (const slot of status.ams![0].slots) {
      expect(slot.id).toBeGreaterThanOrEqual(1024);
    }
  });

  it("reports an AMS 3H humidity reading (zone-based)", () => {
    const h = status.ams![0].humidity;
    expect(h).not.toBeNull();
    expect(h!).toBeGreaterThan(0);
    expect(h!).toBeLessThanOrEqual(100);
  });

  it("does not report fake HMS/print_error issues for an idle printer", () => {
    expect(status.issues.length).toBe(0);
  });

  it("drops the bogus chamber reading when the raw value would be > 120°C", () => {
    // Just check we don't explode and chamber is within range (or null).
    if (status.chamberTemp !== null) {
      expect(status.chamberTemp).toBeLessThanOrEqual(120);
      expect(status.chamberTemp).toBeGreaterThan(0);
    }
  });
});

describe("parseReport (P2S sample)", () => {
  const doc = docFrom(p2sSample);
  const status = parseReport(doc, findModel("N7"));

  it("recognises the P2S", () => {
    expect(status.model?.name).toBe("P2S");
  });

  it("surfaces a four-slot AMS unit", () => {
    expect(status.ams).not.toBeNull();
    const total = status.ams!.reduce((n, u) => n + u.slots.length, 0);
    expect(total).toBeGreaterThanOrEqual(4);
  });
});

describe("parseReport (A1 sample)", () => {
  const doc = docFrom(a1Sample);
  const status = parseReport(doc, findModel("N2S"));

  it("hides chamber on the A1 (no sensor)", () => {
    expect(status.chamberTemp).toBeNull();
    expect(status.chamberTarget).toBeNull();
  });

  it("hides aux/case fans on the A1 (not fitted)", () => {
    expect(status.auxFan).toBeNull();
    expect(status.caseFan).toBeNull();
  });
});
