// Change Settings > Advanced: "How to handle research findings" and "Revenue & Currency" (moved here from two Settings
// cards, 1.2.1.10). They are ordinary Change Settings steps now - Previous / Save / Next, "Unsaved changes" until Save
// (RULE 2026-10-06: nothing is saved until Save is pressed). The rule rows and the rates grid are generated from
// ARBITRATION_RULES / SUPPORTED_CURRENCIES, so a rule or currency added to its module needs no second edit here.
// Edits are kept in a pending patch per step; persistAdvancedStep() writes it. The "back to the defaults" buttons still
// save at once - they ask first.

import { getWebFindingsArbitration, saveWebFindingsArbitration, getRevenueNormalization, saveRevenueNormalization, appendActivityLog } from "./storage.js";
import { RULES as ARBITRATION_RULES, DEFAULT_ARBITRATION_SETTINGS } from "./web-findings-arbitration.js";
import { SUPPORTED_CURRENCIES, DEFAULT_EXCHANGE_RATES } from "./value-normalize.js";
import { askConfirm } from "./confirm-dialog.js";

export const ADVANCED_CARD_STEPS = ["findings", "revenue"];

const NUMBER_FIELDS = [
  { id: "web-findings-tolerance", path: ["tolerancePct"], min: 0, max: 100 },
  { id: "web-findings-max-employees", path: ["illogical", "maxEmployees"], min: 1 },
  { id: "web-findings-rev-floor", path: ["illogical", "revenueUnitsFloor"], min: 0 },
  { id: "web-findings-rev-ceil", path: ["illogical", "revenueUnitsCeil"], min: 0 },
  { id: "web-findings-rpe-min", path: ["illogical", "revPerEmployeeMin"], min: 0 },
  { id: "web-findings-rpe-max", path: ["illogical", "revPerEmployeeMax"], min: 0 },
];

const LABELS = { findings: "Research findings settings", revenue: "Revenue & Currency" };
const SAVERS = { findings: saveWebFindingsArbitration, revenue: saveRevenueNormalization };

const pending = { findings: {}, revenue: {} };
let markDirty = () => {};
let ratesShown = null;

const $ = (id) => document.getElementById(id);
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function mergePatch(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isPlainObj(v) && isPlainObj(out[k]) ? mergePatch(out[k], v) : v;
  return out;
}
function stage(step, patch) {
  pending[step] = mergePatch(pending[step], patch);
  markDirty();
}

function fillFindings(settings) {
  for (const rule of ARBITRATION_RULES) {
    const box = $(`web-findings-rule-${rule.id}`);
    if (box) box.checked = Boolean(settings[rule.setting]);
  }
  for (const f of NUMBER_FIELDS) {
    const input = $(f.id);
    if (input) input.value = (f.path.length === 2 ? settings[f.path[0]]?.[f.path[1]] : settings[f.path[0]]) ?? "";
  }
  $("web-findings-preference").value = settings.sourcePreference || "existing";
  $("web-findings-linkedin-authoritative").checked = Boolean(settings.linkedinAuthoritative);
  $(settings.askEveryDifference ? "findings-mode-ask" : "findings-mode-auto").checked = true;
}

function fillRevenue(settings) {
  ratesShown = settings.rates;
  $("revenue-currency-select").value = settings.targetCurrency;
  $("revenue-rates-asof-input").value = settings.asOf || "";
  $("revenue-rates-asof").textContent = `Rates as last checked on ${settings.asOf || "an unknown date"}.`;
  for (const code of SUPPORTED_CURRENCIES) {
    const input = $(`revenue-rate-${code}`);
    if (input) input.value = settings.rates[code] ?? "";
  }
}

function buildFindings() {
  const wrap = $("web-findings-rules");
  wrap.innerHTML = "";
  for (const rule of ARBITRATION_RULES) {
    const label = document.createElement("label");
    label.className = "checkbox-label web-findings-rule";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `web-findings-rule-${rule.id}`;
    label.appendChild(box);
    // Named, not numbered - see ruleLabel() in target-accounts.js for why.
    label.appendChild(document.createTextNode(` ${rule.label}`));
    const detail = document.createElement("p");
    detail.className = "field-hint web-findings-rule-detail";
    detail.textContent = rule.detail;
    wrap.append(label, detail);
    box.addEventListener("change", () => stage("findings", { [rule.setting]: box.checked }));
  }
  for (const id of ["findings-mode-auto", "findings-mode-ask"]) {
    $(id).addEventListener("change", () => stage("findings", { askEveryDifference: $("findings-mode-ask").checked }));
  }
  for (const f of NUMBER_FIELDS) {
    const input = $(f.id);
    // "change", not "input": a half-typed number is not taken, and an empty box puts the default back rather than a
    // NaN that every later comparison would silently fail.
    input.addEventListener("change", () => {
      const raw = Number(input.value);
      const fallback = f.path.length === 2 ? DEFAULT_ARBITRATION_SETTINGS[f.path[0]][f.path[1]] : DEFAULT_ARBITRATION_SETTINGS[f.path[0]];
      let value = Number.isFinite(raw) && input.value !== "" ? raw : fallback;
      if (f.min !== undefined) value = Math.max(f.min, value);
      if (f.max !== undefined) value = Math.min(f.max, value);
      input.value = value;
      stage("findings", f.path.length === 2 ? { [f.path[0]]: { [f.path[1]]: value } } : { [f.path[0]]: value });
    });
  }
  $("web-findings-preference").addEventListener("change", (e) => stage("findings", { sourcePreference: e.target.value }));
  $("web-findings-linkedin-authoritative").addEventListener("change", (e) => stage("findings", { linkedinAuthoritative: e.target.checked }));
  $("web-findings-reset-btn").addEventListener("click", async () => {
    if (!(await askConfirm(
      "Put every rule, tolerance and threshold here back to the way SalesTeam ships them?\n\nThis only changes the settings - nothing already decided on your accounts is touched.",
      { okLabel: "Put back the defaults", cancelLabel: "Cancel" }
    ))) return;
    pending.findings = {};
    fillFindings(await saveWebFindingsArbitration(DEFAULT_ARBITRATION_SETTINGS));
    $("web-findings-status").textContent = "Back to the defaults.";
    appendActivityLog({ actor: "user", action: "web_findings_arbitration_reset", label: "Web findings arbitration settings put back to the defaults" });
  });
}

function buildRevenue() {
  const select = $("revenue-currency-select");
  select.innerHTML = "";
  for (const code of SUPPORTED_CURRENCIES) select.appendChild(new Option(code, code));
  const grid = $("revenue-rates-grid");
  grid.innerHTML = "";
  for (const code of SUPPORTED_CURRENCIES) {
    const label = document.createElement("label");
    label.textContent = `1 ${code} = ? USD`;
    const input = document.createElement("input");
    input.type = "number";
    input.id = `revenue-rate-${code}`;
    input.step = "0.0001";
    input.min = "0";
    input.style.width = "140px";
    input.disabled = code === DEFAULT_EXCHANGE_RATES.base;
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value <= 0) {
        input.value = pending.revenue.rates?.[code] ?? ratesShown?.[code] ?? "";
        $("revenue-currency-status").textContent = "A rate has to be a number greater than zero.";
        return;
      }
      $("revenue-currency-status").textContent = "";
      stage("revenue", { rates: { [code]: value } });
    });
    grid.append(label, input);
  }
  select.addEventListener("change", () => stage("revenue", { targetCurrency: select.value }));
  $("revenue-rates-asof-input").addEventListener("change", (e) => stage("revenue", { asOf: e.target.value }));
  $("revenue-rates-reset-btn").addEventListener("click", async () => {
    if (!(await askConfirm(
      "Put every exchange rate back to the values SalesTeam ships with?\n\nThe currency you display revenue in is not changed.",
      { okLabel: "Put back the defaults", cancelLabel: "Cancel" }
    ))) return;
    const { targetCurrency, asOf, ...rest } = pending.revenue;
    pending.revenue = { ...(targetCurrency ? { targetCurrency } : {}) }; // an unsaved currency choice stays unsaved
    fillRevenue(await saveRevenueNormalization({ rates: DEFAULT_EXCHANGE_RATES.rates, asOf: DEFAULT_EXCHANGE_RATES.asOf }));
    if (targetCurrency) $("revenue-currency-select").value = targetCurrency;
    void rest; void asOf;
    $("revenue-currency-status").textContent = "Rates back to the defaults.";
  });
}

// Builds both steps and fills them from storage. onDirty is the wizard's "this step has unsaved changes".
export async function mountAdvancedSteps({ onDirty }) {
  if (!$("web-findings-rules")) return;
  markDirty = onDirty || (() => {});
  buildFindings();
  buildRevenue();
  fillFindings(await getWebFindingsArbitration());
  fillRevenue(await getRevenueNormalization());
}

export async function persistAdvancedStep(step) {
  const patch = pending[step];
  if (!patch || !Object.keys(patch).length) return;
  const next = await SAVERS[step](patch);
  pending[step] = {};
  if (step === "findings") fillFindings(next);
  else fillRevenue(next);
  appendActivityLog({ actor: "user", action: "settings_card_saved", label: `${LABELS[step]} saved (${Object.keys(patch).join(", ")})`, newValue: patch });
}

// "Don't save": the step shows what is stored again.
export async function discardAdvancedStep(step) {
  pending[step] = {};
  if (step === "findings") fillFindings(await getWebFindingsArbitration());
  else if (step === "revenue") fillRevenue(await getRevenueNormalization());
}
