// Team use 1.2.2, build step 2 (TEAM_USE_DESIGN.md 4.1, 5.2, 5.3): local storage values <-> team rows.
// PURE - no chrome.*, no DOM - so test_pure_modules.py runs it for real.
//
// A ROW is one record of one local home: a workbook company, a targetAccounts entry, an extras entry, a lead,
// one whole setting. Its fields are the top-level fields of that record. Each row is one entity of team-merge.js,
// keyed "<e>|<id>" with the home in the id ("wb:<companyId>", "ta:<company key>", "x:<company key>"), so writing
// a merged row back lands exactly where it came from. Claims and assignments (steps 4-5) use the bare companyId.
//
//   extractRows(key, value)            local value -> rows
//   diffRows(shadowRows, rows)         rows -> set/delete changes against the last state the team knows
//   projectRow(state, e, id)           merged state -> the row's fields (or null: the row does not exist)
//   patchValue(key, value, updates)    write merged rows back into a local value, leaving every other row alone

import { entityView, getRecord } from "./team-merge.js";
import {
  TEAM_WORKBOOK_KEY, TEAM_WORKBOOK_SHEETS, TEAM_WORKBOOK_REST_ID, TEAM_MAP_KEYS, TEAM_WHOLE_KEYS, teamKeyKind,
} from "./team-keys.js";

// A field that was removed from a row. Sent as a value so it is ordered like any other change (later wins).
export const UNSET = { $unset: 1 };
export function isUnset(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && v.$unset === 1 && Object.keys(v).length === 1;
}

export const rowKey = (e, id) => `${e}|${id}`;
export function splitRowKey(k) {
  const i = String(k).indexOf("|");
  return { e: k.slice(0, i), id: k.slice(i + 1) };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A record that is not an object (a string, a number, an array) travels as one field "$v".
const asFields = (value) => (isPlainObject(value) ? { ...value } : { $v: value });
function fromFields(fields) {
  const keys = Object.keys(fields);
  return keys.length === 1 && keys[0] === "$v" ? fields.$v : fields;
}
const validId = (id) => (typeof id === "string" && id !== "") || (typeof id === "number" && Number.isFinite(id));

// Top-level fields sorted, so the same row always gives the same text whatever order its fields were written in.
export function canonicalRow(fields) {
  const sorted = {};
  for (const k of Object.keys(fields).sort()) sorted[k] = fields[k];
  return JSON.stringify(sorted);
}

const mapSpec = (key) => TEAM_MAP_KEYS.find((m) => m.key === key) || null;

// Splits one workbook sheet into rows addressable by id and the rest (no id, or an id an earlier row already has).
function splitSheet(rows, idField) {
  const byId = [];
  const extra = [];
  const ids = new Set();
  for (const row of rows) {
    const id = isPlainObject(row) ? row[idField] : undefined;
    if (validId(id) && !ids.has(String(id))) {
      ids.add(String(id));
      byId.push(row);
    } else {
      extra.push(row);
    }
  }
  return { byId, extra };
}

// --------------------------------------------------------------------------
// Local value -> rows
// --------------------------------------------------------------------------

// -> Map rowKey -> fields. An absent value (undefined) has no rows.
export function extractRows(key, value) {
  const rows = new Map();
  const kind = teamKeyKind(key);
  if (value === undefined || !kind) return rows;
  if (kind === "whole") {
    rows.set(rowKey("setting", key), { $v: value });
    return rows;
  }
  if (kind === "map") {
    const spec = mapSpec(key);
    if (!isPlainObject(value)) return rows;
    for (const [k, v] of Object.entries(value)) {
      const fields = asFields(v);
      for (const p of spec.personal || []) delete fields[p];
      rows.set(rowKey(spec.e, `${spec.prefix}${k}`), fields);
    }
    return rows;
  }
  // workbook
  if (!isPlainObject(value)) return rows;
  const rest = {};
  for (const [k, v] of Object.entries(value)) {
    const sheet = TEAM_WORKBOOK_SHEETS.find((s) => s.sheet === k);
    if (!sheet || !Array.isArray(v)) rest[k] = v;
  }
  for (const s of TEAM_WORKBOOK_SHEETS) {
    if (!Array.isArray(value[s.sheet])) continue;
    const { byId, extra } = splitSheet(value[s.sheet], s.idField);
    for (const row of byId) rows.set(rowKey(s.e, `${s.prefix}${row[s.idField]}`), { ...row });
    if (extra.length) rest[`$extra.${s.sheet}`] = extra;
    else rest[`$sheet.${s.sheet}`] = true; // the sheet exists, even when every row has an id (or it is empty)
  }
  rows.set(rowKey("setting", TEAM_WORKBOOK_REST_ID), rest);
  return rows;
}

// Which local home a row belongs to: { key, sheet?, localId? }, or null (not a row - e.g. a claim on a bare id).
export function rowTarget(e, id) {
  id = String(id);
  if (e === "setting" && id === TEAM_WORKBOOK_REST_ID) return { key: TEAM_WORKBOOK_KEY, part: "rest" };
  for (const s of TEAM_WORKBOOK_SHEETS) {
    if (s.e === e && id.startsWith(s.prefix) && id.length > s.prefix.length) {
      return { key: TEAM_WORKBOOK_KEY, sheet: s.sheet, localId: id.slice(s.prefix.length) };
    }
  }
  for (const m of TEAM_MAP_KEYS) {
    if (m.e === e && id.startsWith(m.prefix) && id.length > m.prefix.length) {
      return { key: m.key, localId: id.slice(m.prefix.length) };
    }
  }
  if (e === "setting" && TEAM_WHOLE_KEYS.includes(id)) return { key: id };
  return null;
}

// --------------------------------------------------------------------------
// Rows -> changes (local -> team)
// --------------------------------------------------------------------------
// shadowRows: { rowKey: canonicalRow } - the last state of this key the team is known to have.
// -> { sets: [{ e, id, f, isNew }], dels: [{ e, id }], shadow } where f holds only the fields that differ
// (a removed field as UNSET) and `shadow` is the new shadow for this key.
export function diffRows(shadowRows, rows) {
  const sets = [];
  const dels = [];
  const shadow = {};
  for (const [rk, fields] of rows) {
    const json = canonicalRow(fields);
    shadow[rk] = json;
    const old = shadowRows[rk];
    if (old === json) continue;
    const before = old ? JSON.parse(old) : {};
    const f = {};
    for (const [field, v] of Object.entries(fields)) {
      if (!(field in before) || JSON.stringify(v) !== JSON.stringify(before[field])) f[field] = v;
    }
    for (const field of Object.keys(before)) if (!(field in fields)) f[field] = UNSET;
    const { e, id } = splitRowKey(rk);
    if (Object.keys(f).length) sets.push({ e, id, f, isNew: !old });
  }
  for (const rk of Object.keys(shadowRows)) {
    if (!rows.has(rk)) dels.push(splitRowKey(rk));
  }
  return { sets, dels, shadow };
}

// A row that is new to the shadow may still have old fields in the merged state (it was deleted earlier; a later
// set revives the row with every field it ever had). The fields the new row does not have are cleared.
export function staleFieldUnsets(state, e, id, fields) {
  const rec = getRecord(state, e, id);
  const out = {};
  if (!rec) return out;
  for (const [field, { v }] of Object.entries(rec.f)) {
    if (!(field in fields) && !isUnset(v)) out[field] = UNSET;
  }
  return out;
}

// --------------------------------------------------------------------------
// Merged state -> rows (team -> local)
// --------------------------------------------------------------------------

export function projectRow(state, e, id) {
  const view = entityView(state, e, id);
  if (!view || !view.exists) return null;
  const fields = {};
  for (const [k, v] of Object.entries(view.values)) if (!isUnset(v)) fields[k] = v;
  return Object.keys(fields).length ? fields : null;
}

// Every existing row of one storage key in the merged state -> Map rowKey -> fields (joining a team).
export function projectKey(state, key) {
  const out = new Map();
  for (const [e, byId] of Object.entries(state.entities || {})) {
    for (const id of Object.keys(byId).sort()) {
      const target = rowTarget(e, id);
      if (!target || target.key !== key) continue;
      const fields = projectRow(state, e, id);
      if (fields) out.set(rowKey(e, id), fields);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Rows -> local value
// --------------------------------------------------------------------------
// updates: Map rowKey -> fields | null (null = the row no longer exists). Rows not in `updates` are left exactly
// as they are; a lead keeps its personal fields (draft, Sales Mentor history). Returns the new value
// (undefined = remove the key).
export function patchValue(key, current, updates) {
  const kind = teamKeyKind(key);
  if (!kind) return current;
  if (kind === "whole") {
    if (!updates.has(rowKey("setting", key))) return current;
    const fields = updates.get(rowKey("setting", key));
    return fields ? fromFields(fields) : undefined;
  }
  if (kind === "map") {
    const spec = mapSpec(key);
    const obj = isPlainObject(current) ? { ...current } : {};
    for (const [rk, fields] of updates) {
      const { e, id } = splitRowKey(rk);
      const target = rowTarget(e, id);
      if (!target || target.key !== key) continue;
      if (!fields) {
        delete obj[target.localId];
        continue;
      }
      let v = fromFields(fields);
      const before = obj[target.localId];
      if (spec.personal && isPlainObject(v) && isPlainObject(before)) {
        v = { ...v };
        for (const p of spec.personal) if (p in before) v[p] = before[p];
      }
      obj[target.localId] = v;
    }
    // A key that did not exist and has no rows stays absent (an empty map and no map have the same rows).
    return current === undefined && !Object.keys(obj).length ? undefined : obj;
  }
  // workbook
  const wb = isPlainObject(current) ? { ...current } : {};
  const restKey = rowKey("setting", TEAM_WORKBOOK_REST_ID);
  const rest = updates.has(restKey) ? updates.get(restKey) || {} : null;
  if (rest) {
    const sheetNames = TEAM_WORKBOOK_SHEETS.map((s) => s.sheet);
    for (const k of Object.keys(wb)) if (!sheetNames.includes(k) || !Array.isArray(wb[k])) delete wb[k];
    for (const [k, v] of Object.entries(rest)) if (!k.startsWith("$")) wb[k] = v;
  }
  for (const s of TEAM_WORKBOOK_SHEETS) {
    const sheetUpdates = new Map();
    for (const [rk, fields] of updates) {
      const { e, id } = splitRowKey(rk);
      const target = rowTarget(e, id);
      if (target && target.sheet === s.sheet) sheetUpdates.set(target.localId, fields);
    }
    const restHasSheet = rest && (`$extra.${s.sheet}` in rest || `$sheet.${s.sheet}` in rest);
    if (!sheetUpdates.size && !restHasSheet) continue;
    if (rest && !restHasSheet && s.sheet in rest) continue; // the sheet is not an array: restored whole above
    const { byId, extra } = splitSheet(Array.isArray(wb[s.sheet]) ? wb[s.sheet] : [], s.idField);
    const out = [];
    const present = new Set();
    for (const row of byId) {
      const id = String(row[s.idField]);
      present.add(id);
      if (!sheetUpdates.has(id)) out.push(row);
      else if (sheetUpdates.get(id)) out.push(sheetUpdates.get(id));
    }
    const added = [...sheetUpdates.keys()].filter((id) => !present.has(id) && sheetUpdates.get(id)).sort();
    for (const id of added) out.push(sheetUpdates.get(id));
    const extraRows = rest ? rest[`$extra.${s.sheet}`] || [] : extra;
    wb[s.sheet] = [...out, ...extraRows];
  }
  return wb;
}
