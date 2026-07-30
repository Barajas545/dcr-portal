/* TEMP verification stub for the expenses tab — deleted after the check. */
(function () {
  var ROWS = [
    { id: 1, expenseDate: "2026-07-05", gropingName: "Framing", description: "Lumber package delivery", estimate: 5000, invoice: 0, materials: 4200.5, contractors: 0, remarks: "" },
    { id: 2, expenseDate: "2026-07-28", gropingName: "Framing", description: "Crew labor week 30", estimate: 3000, invoice: 3000, materials: 0, contractors: 2750, remarks: "" },
    { id: 3, expenseDate: "2026-06-15", gropingName: "Concrete", description: "Footings pour", estimate: 2000, invoice: 2000, materials: 900, contractors: 1100, remarks: "" },
    { id: 4, expenseDate: "2026-06-02", gropingName: "Concrete", description: "Rebar + forms", estimate: 800, invoice: 0, materials: 640.25, contractors: 0, remarks: "" },
    { id: 5, expenseDate: "2026-05-20", gropingName: "Windows", description: "Andersen 400 series order<br>Unit A: 3050 XO slider<br>Unit B: 2040 fixed picture window with tempered glass on the stair landing per plan sheet A4.2", estimate: 1500, invoice: 1500, materials: 1325.75, contractors: 200, remarks: "Lead time 6 weeks — confirm rough openings before release" },
    { id: 6, expenseDate: "2026-01-10", gropingName: "Framing", description: "Deposit — engineered beams", estimate: 1200, invoice: 1200, materials: 1150, contractors: 0, remarks: "" },
    { id: 7, expenseDate: "2025-11-12", gropingName: "Roofing", description: "Shingles", estimate: 4000, invoice: 4000, materials: 3800, contractors: 0, remarks: "" },
    { id: 8, expenseDate: "2026-07-20", gropingName: "", description: "Dumpster rental", estimate: 500, invoice: 0, materials: 0, contractors: 475, remarks: "" }
  ];
  var deleted = [];
  window.__EXP = { rows: ROWS, deleted: deleted };

  function ready() {
    if (!window.DCR) return setTimeout(ready, 5);
    DCR.requireAuth = async function () { return { role: "Admin", name: "Harness" }; };
    DCR.blobUrl = async function () { return ""; };
    DCR.api = async function (url, opt) {
      opt = opt || {};
      if (opt.method === "POST") {
        var b = opt.body || {};
        if (b.op === "expDelete") {
          deleted.push(b.itemId);
          ROWS = ROWS.filter(function (r) { return String(r.id) !== String(b.itemId); });
          return { ok: true };
        }
        return { ok: true };
      }
      if (url.indexOf("part=expenses") > -1) return { rows: ROWS.slice(), canEdit: true };
      if (url.indexOf("action=project&id=") > -1 && url.indexOf("part=") === -1)
        return {
          project: { id: 1, internalIDNumber: "A177", projectName: "Harness Deck", projectAddress: "1 Test St", projectCity: "Portland", projectClientName: "Test Client", estimateStatus: "In Progress" },
          canWrite: true, canEstimate: true, canLog: true, driveReady: false
        };
      return { rows: [], projects: [], logs: [] };
    };
  }
  ready();
})();
