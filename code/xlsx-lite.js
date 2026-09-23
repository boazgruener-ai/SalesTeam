// A minimal, dependency-free .xlsx reader - just enough to read the "Companies"
// sheet of the externally-maintained Target Accounts workbook (see storage.js's
// importTargetAccounts / PRD.md 6.11) directly from the file the user picks in
// Settings, with no Python conversion step required. Deliberately not a general
// xlsx library - no styles, dates, merged cells, or write support - because
// pulling in a third-party parsing library into a browser extension (one with
// linkedin.com/api.anthropic.com host permissions) is its own real risk, and a
// full library is unnecessary for reading six known columns off one sheet.
// An .xlsx file is a zip archive of XML parts; this hand-rolls just enough zip
// (central directory + local headers, using the browser's native
// DecompressionStream for the actual inflate) and reuses the browser's own
// DOMParser for the XML, so nothing outside the platform is required.

// v38+ workbooks (2026-09-15) rename every "AI_"-prefixed sheet/column to
// drop the "AI_" - the user deliberately genericized the ChatGPT template
// so it can be reused for a non-AI product line later, not an accident.
// Each entry below is a list of acceptable header spellings for one
// logical column, newest first - the first one found in a given workbook
// wins, so this reads either vintage with no separate code path.
const NEEDED_HEADER_ALIASES = {
  Company: ["Company"],
  Industry: ["Industry"],
  AI_Priority_Score: ["Priority_Score", "AI_Priority_Score"],
  AI_Priority: ["Priority", "AI_Priority"],
  Research_Status: ["Research_Status"],
  Top_AI_Initiatives: ["Top_Initiatives", "Top_AI_Initiatives"],
};
const NEEDED_HEADERS = Object.values(NEEDED_HEADER_ALIASES).flat();

// Spreadsheet XML parts aren't guaranteed to use the default (unprefixed)
// namespace - a workbook produced by some tools (confirmed with a real
// workbook during development) declares it under an explicit prefix instead
// (e.g. <x:sheet> rather than <sheet>). getElementsByTagName matches on the
// literal tag name including any prefix, so a prefix choice like that would
// silently break every lookup; getElementsByTagNameNS matches by namespace
// URI + local name regardless of whatever prefix the source file happens to
// use, so every tag lookup below goes through it instead.
const SML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

function tag(doc, name) {
  return doc.getElementsByTagNameNS(SML_NS, name);
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Couldn't parse an XML part inside the .xlsx file - it may be corrupt.");
  }
  return doc;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Reads just the central directory (zip's table of contents) - entries are
// looked up and inflated lazily, only for the handful of XML parts actually
// needed, not the whole archive (a workbook this size also embeds calculated
// chain, theme, styles, etc. that are irrelevant here).
function readCentralDirectory(bytes, view) {
  const EOCD_SIG = 0x06054b50;
  const minPos = Math.max(0, bytes.length - 22 - 65535);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("That doesn't look like a valid .xlsx file (no zip end-of-directory record found).");

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries = new Map();
  const CD_SIG = 0x02014b50;
  let ptr = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(ptr, true) !== CD_SIG) throw new Error("That .xlsx file's zip directory looks corrupt.");
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.set(name, { offset: localHeaderOffset, compressedSize, method });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

class ZipReader {
  constructor(bytes, view, entries) {
    this.bytes = bytes;
    this.view = view;
    this.entries = entries;
  }

  static fromArrayBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    return new ZipReader(bytes, view, readCentralDirectory(bytes, view));
  }

  has(name) {
    return this.entries.has(name);
  }

  async readText(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`This .xlsx file has no "${name}" part - it may be an unusual/corrupt workbook.`);
    const { offset, compressedSize, method } = entry;
    const nameLen = this.view.getUint16(offset + 26, true);
    const extraLen = this.view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + nameLen + extraLen;
    const compressed = this.bytes.subarray(dataStart, dataStart + compressedSize);
    let raw;
    if (method === 0) raw = compressed;
    else if (method === 8) raw = await inflateRaw(compressed);
    else throw new Error(`Unsupported zip compression (method ${method}) for "${name}".`);
    return new TextDecoder("utf-8").decode(raw);
  }
}

function parseSharedStrings(xmlText) {
  const doc = parseXml(xmlText);
  return Array.from(tag(doc, "si")).map((si) => si.textContent || "");
}

// Resolves the "Companies" sheet's actual XML part filename - workbook.xml
// only names sheets and assigns each a relationship id; the real filename
// (e.g. worksheets/sheet3.xml) lives in the separate .rels file, and sheet
// order/numbering isn't guaranteed to match sheet position.
function resolveSheetTarget(workbookXml, relsXml, sheetName) {
  const wbDoc = parseXml(workbookXml);
  const sheetEl = Array.from(tag(wbDoc, "sheet")).find((el) => el.getAttribute("name") === sheetName);
  if (!sheetEl) return null;
  const ridAttr = Array.from(sheetEl.attributes).find((a) => a.localName === "id" || a.name.endsWith(":id"));
  if (!ridAttr) return null;

  const relsDoc = parseXml(relsXml);
  const relEl = Array.from(relsDoc.getElementsByTagNameNS(REL_NS, "Relationship")).find((el) => el.getAttribute("Id") === ridAttr.value);
  return relEl ? relEl.getAttribute("Target") : null;
}

// A Relationship Target starting with "/" is already package-root-relative
// (confirmed with a real workbook that writes targets this way, e.g.
// "/xl/worksheets/sheet3.xml"); otherwise it's relative to the referencing
// part's own folder, which for workbook.xml.rels is "xl/" (the more common
// form, e.g. "worksheets/sheet3.xml").
function resolveSheetPath(workbookXml, relsXml, sheetName) {
  const target = resolveSheetTarget(workbookXml, relsXml, sheetName);
  if (!target) return null;
  return target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.?\/*/, "");
}

// "Global_HQ_City" -> "globalHqCity", "Company_ID" -> "companyId" - a
// predictable, reversible-enough mapping from the workbook's own
// ALL_CAPS_WITH_UNDERSCORES header convention to normal JS property names,
// used by the generic multi-sheet reader below (unlike parseCompanyRows,
// which only ever needed six specific, already-known headers).
function camelCaseHeader(header) {
  return header
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word, i) => {
      const lower = word.toLowerCase();
      return i === 0 ? lower : lower[0].toUpperCase() + lower.slice(1);
    })
    .join("");
}

function columnLetters(cellRef) {
  const m = /^([A-Z]+)\d+$/.exec(cellRef || "");
  return m ? m[1] : null;
}

function cellValue(cEl, sharedStrings) {
  const t = cEl.getAttribute("t");
  if (t === "s") {
    const v = cEl.getElementsByTagNameNS(SML_NS, "v")[0];
    const idx = v ? parseInt(v.textContent, 10) : -1;
    return sharedStrings[idx] ?? null;
  }
  if (t === "inlineStr") {
    const is = cEl.getElementsByTagNameNS(SML_NS, "is")[0];
    return is ? is.textContent : null;
  }
  if (t === "str") {
    const v = cEl.getElementsByTagNameNS(SML_NS, "v")[0];
    return v ? v.textContent : null;
  }
  if (t === "b") {
    const v = cEl.getElementsByTagNameNS(SML_NS, "v")[0];
    return v ? v.textContent === "1" : null;
  }
  const v = cEl.getElementsByTagNameNS(SML_NS, "v")[0];
  if (!v || v.textContent === "") return null;
  const num = parseFloat(v.textContent);
  return Number.isNaN(num) ? null : num;
}

function parseCompanyRows(sheetXml, sharedStrings) {
  const doc = parseXml(sheetXml);
  const rows = Array.from(tag(doc, "row"));
  if (rows.length === 0) return [];

  const headerByCol = {};
  for (const c of Array.from(rows[0].getElementsByTagNameNS(SML_NS, "c"))) {
    const col = columnLetters(c.getAttribute("r"));
    if (!col) continue;
    const value = cellValue(c, sharedStrings);
    if (value != null) headerByCol[col] = String(value).trim();
  }
  // Resolved per logical key (colByHeader.AI_Priority_Score etc.), not per
  // literal header string - a workbook only ever has one spelling of each
  // column present, so this picks whichever of NEEDED_HEADER_ALIASES'
  // candidates actually exists, newest spelling first.
  const colByHeader = {};
  for (const [logicalKey, candidates] of Object.entries(NEEDED_HEADER_ALIASES)) {
    for (const [col, header] of Object.entries(headerByCol)) {
      if (candidates.includes(header)) {
        colByHeader[logicalKey] = col;
        break;
      }
    }
  }
  const missing = Object.keys(NEEDED_HEADER_ALIASES).filter((k) => !(k in colByHeader));
  if (missing.length > 0) {
    const spellings = missing.map((k) => NEEDED_HEADER_ALIASES[k].join(" or ")).join(", ");
    throw new Error(`This workbook's "Companies" sheet is missing expected column(s): ${spellings}.`);
  }

  const entries = [];
  for (let i = 1; i < rows.length; i++) {
    const rowValues = {};
    for (const c of Array.from(rows[i].getElementsByTagNameNS(SML_NS, "c"))) {
      const col = columnLetters(c.getAttribute("r"));
      if (col) rowValues[col] = cellValue(c, sharedStrings);
    }
    const company = rowValues[colByHeader.Company];
    if (!company) continue;
    const score = rowValues[colByHeader.AI_Priority_Score];
    if (score == null) continue;
    entries.push({
      company,
      industry: rowValues[colByHeader.Industry] ?? null,
      score: typeof score === "number" ? score : parseFloat(score),
      priorityLabel: rowValues[colByHeader.AI_Priority] ?? null,
      researchStatus: rowValues[colByHeader.Research_Status] ?? null,
      topInitiatives: rowValues[colByHeader.Top_AI_Initiatives] ?? null,
    });
  }
  return entries;
}

// Entry point - takes the raw ArrayBuffer of a picked .xlsx file, returns the
// same {company, industry, score, priorityLabel, researchStatus,
// topInitiatives}[] shape convert_target_accounts.py produces, so callers
// (settings.js) can pass it straight to storage.js's importTargetAccounts
// either way.
export async function parseTargetAccountsWorkbook(arrayBuffer) {
  const zip = ZipReader.fromArrayBuffer(arrayBuffer);

  const workbookXml = await zip.readText("xl/workbook.xml");
  const relsXml = await zip.readText("xl/_rels/workbook.xml.rels");
  const sheetPath = resolveSheetPath(workbookXml, relsXml, "Companies");
  if (!sheetPath) throw new Error('Could not find a "Companies" sheet in this workbook.');

  const sharedStrings = zip.has("xl/sharedStrings.xml")
    ? parseSharedStrings(await zip.readText("xl/sharedStrings.xml"))
    : [];

  const sheetXml = await zip.readText(sheetPath);
  return parseCompanyRows(sheetXml, sharedStrings);
}

// Keeps every column (unlike parseCompanyRows' six named ones), camelCased -
// used for the full Target Accounts Explorer (PRD 6.12), which needs the
// whole row per sheet, not just the handful of fields Idea 1's prioritization
// logic cares about. A row with every cell blank is dropped; anything with
// at least one real value is kept, even if some of its columns are empty.
// v38+ workbooks (2026-09-15) rename every "AI_"-prefixed column to drop
// the "AI_" (e.g. "AI_Priority_Score" -> "Priority_Score", camelCased to
// priorityScore instead of the aiPriorityScore every downstream consumer
// - storage.js, target-accounts.js, agent-shared.js - already expects).
// Rather than touch every one of those call sites, each short name is
// aliased onto its "ai"-prefixed key right here at parse time, same
// "normalize at import, callers never need to know which schema produced
// a row" approach already used for the Contacts sheet's three schema
// variants.
//
// Bidirectional as of 2026-09-17 (was short-to-ai only) - the user's own
// rule-builder UI (onboarding.js) and its default seed rules (storage.js)
// were reported directly as still showing "aiPriority" etc. even after the
// user's workbook fully dropped every AI mention "in the last several file
// versions." Fixed by having both the UI and the seed rules reference the
// short, real column name instead (see their own comments) - which only
// works correctly for an OLDER, still-"AI_"-prefixed workbook too if the
// short key gets backfilled from the ai-prefixed one as well, not just the
// other way around. Each direction only fires when its own target is
// still missing, so neither a modern (short-only) nor a legacy (ai-prefixed-
// only) workbook is a no-op for whichever key some caller happens to ask
// for.
export const AI_FIELD_ALIASES = {
  priorityScore: "aiPriorityScore",
  priority: "aiPriority",
  portfolioProfile: "aiPortfolioProfile",
  portfolioProfileConfidence: "aiPortfolioProfileConfidence",
  investmentGlobal: "aiInvestmentGlobal",
  investmentSwitzerland: "aiInvestmentSwitzerland",
  investmentConfidence: "aiInvestmentConfidence",
  topInitiatives: "topAiInitiatives",
  maturityFitScore: "aiMaturityFitScore",
  useCaseFitScore: "aiUseCaseFitScore",
  relevance: "aiRelevance",
  // Reported directly 2026-09-17 (the same "AI" mentions ChatGPT was asked
  // to drop from every column/field, "already in the last several file
  // versions") - this one entry was missing from the list above, found by
  // cross-checking every "ai"-prefixed id target-accounts.js's own
  // COMPANY_COLUMNS expects against this alias table.
  investmentScore: "aiInvestmentScore",
};

// Country-neutral workbook headers (what the generic research prompt produces:
// "Home" = the country of the user's own company, "Registry" = that country's
// official company registry) -> the internal field ids, which keep the older
// swiss*/zefix* spelling that the first workbook (V66) used, so existing data
// and every consumer of those ids (LinkedIn resolver, size scoring, Explorer
// columns) stay untouched. Only fills the internal id when it is still missing,
// so a legacy workbook imports exactly as before.
export const HOME_FIELD_ALIASES = {
  registryOfficialName: "zefixOfficialName",
  registryId: "zefixUid",
  registryAddress: "zefixAddress",
  mainHomeLocation: "mainSwissLocation",
  homeDecisionAuthority: "swissDecisionAuthority",
  homeRevenue: "swissRevenue",
  homeRevenueCurrency: "swissRevenueCurrency",
  homeRevenuePeriod: "swissRevenuePeriod",
  homeRevenueConfidence: "swissRevenueConfidence",
  homeEmployees: "swissEmployees",
  homeEmployeesPeriod: "swissEmployeesPeriod",
  homeEmployeesConfidence: "swissEmployeesConfidence",
  investmentHome: "investmentSwitzerland",
  homeSizeFitScore: "swissSizeFitScore",
  homeBased: "swissBased",
};

function applyAiFieldAliases(row) {
  for (const [homeKey, legacyKey] of Object.entries(HOME_FIELD_ALIASES)) {
    if (row[legacyKey] === undefined && row[homeKey] !== undefined) row[legacyKey] = row[homeKey];
  }
  for (const [shortKey, aiKey] of Object.entries(AI_FIELD_ALIASES)) {
    if (row[aiKey] === undefined && row[shortKey] !== undefined) row[aiKey] = row[shortKey];
    else if (row[shortKey] === undefined && row[aiKey] !== undefined) row[shortKey] = row[aiKey];
  }
  return row;
}

function parseGenericSheetRows(sheetXml, sharedStrings) {
  const doc = parseXml(sheetXml);
  const rows = Array.from(tag(doc, "row"));
  if (rows.length === 0) return [];

  // A duplicate header name (confirmed live in a real workbook: the
  // Contacts sheet has two separate "Last_Verified"/"Evidence_Quality"
  // pairs - a source-verification date pair, then a distinct LinkedIn-
  // verification pair) would otherwise silently collide: rowValues[header]
  // = value below is a plain object write, so the later column would
  // overwrite the earlier one with no error and no sign anything was lost.
  // Every column after the first occurrence of a given header gets a
  // numeric suffix (lastVerified, lastVerified2, lastVerified3, ...) so
  // every column's data survives under its own key - the caller decides
  // what each one actually means.
  const headerByCol = {};
  const headerSeenCount = {};
  for (const c of Array.from(rows[0].getElementsByTagNameNS(SML_NS, "c"))) {
    const col = columnLetters(c.getAttribute("r"));
    if (!col) continue;
    const value = cellValue(c, sharedStrings);
    if (value == null) continue;
    const base = camelCaseHeader(String(value).trim());
    const seen = (headerSeenCount[base] = (headerSeenCount[base] || 0) + 1);
    headerByCol[col] = seen === 1 ? base : `${base}${seen}`;
  }

  const entries = [];
  for (let i = 1; i < rows.length; i++) {
    const rowValues = {};
    let hasAny = false;
    for (const c of Array.from(rows[i].getElementsByTagNameNS(SML_NS, "c"))) {
      const col = columnLetters(c.getAttribute("r"));
      const header = col && headerByCol[col];
      if (!header) continue;
      const value = cellValue(c, sharedStrings);
      rowValues[header] = value;
      if (value != null) hasAny = true;
    }
    if (hasAny) entries.push(applyAiFieldAliases(rowValues));
  }
  return entries;
}

// The workbook's relational sheets, each referencing Companies via
// Company_ID (camelCased to companyId) - see PRD 6.12. Sheets not listed
// here (README, Dashboard, Scoring_Model, Lookup_Lists, Prospect_List) are
// presentation/methodology content, not per-company records, so the
// Explorer has no use for them. Each value is a list of acceptable sheet
// names, newest first - v38+ workbooks (2026-09-15) renamed AI_Initiatives
// -> Initiatives and AI_Investment -> Investment along with their column
// renames above; the first name found in a given workbook wins.
// exclusionList (added 2026-09-17): a newer ChatGPT workbook carries its own
// "Exclusion_List" sheet - confirmed live (Swiss_AI_Prospects_528_V55_FULL_
// 17-9-2026.xlsx) as exactly 3 columns, Company_ID/Company/Exclusion_Reason
// (camelCased: companyId/company/exclusionReason) - one row per company the
// Companies sheet's own new Excluded column marks "Yes" (confirmed: 10 of
// 528 rows, all reason "Competitor" in this file, though the user's own
// description of the feature says Exclusion_Reason can also be Customer/
// Partner/Other). Company_ID is the reliable join back to Companies (the
// same column both sheets already use for every other relational join in
// this workbook) - see storage.js's backfillCompanyExclusionsFromWorkbook.
// aliases (added 2026-09-19, 28th round of direct feedback): "It has now a
// very extensive list of aliases for each company and also the type of
// alias (short name, German/French, Group brand, etc.)... it could be a
// good idea to import and integrate these aliases now." Confirmed live
// (Swiss_AI_Prospects_544_V66_FULL_17-9-2026.xlsx) as one row per name
// variant - Company_ID/Canonical_Name/Alias/Alias_Type/Language/
// Search_Priority/Normalized_Alias/Source_or_Notes/Source_URL/
// Verification_Status (camelCased: companyId/canonicalName/alias/
// aliasType/language/searchPriority/normalizedAlias/sourceOrNotes/
// sourceUrl/verificationStatus) - 2707 rows across 544 companies in that
// workbook, joined back to Companies the same way every other relational
// sheet here already is. See storage.js's importTargetAccounts for what
// actually consumes these (indexing the Target Accounts lookup by every
// known alias, not just each company's own primary name).
const RELATIONAL_SHEETS = {
  companies: ["Companies"],
  contacts: ["Contacts"],
  aiInitiatives: ["Initiatives", "AI_Initiatives"],
  aiInvestment: ["Investment", "AI_Investment"],
  sources: ["Sources"],
  exclusionList: ["Exclusion_List", "Exclusion List", "ExclusionList"],
  aliases: ["Aliases"],
};

// Reads the full relational slice of the workbook - every column of every
// row in Companies/Contacts/AI_Initiatives/AI_Investment/Sources - for the
// Target Accounts Explorer page. A sheet that isn't present in a given
// workbook (e.g. an older export without AI_Investment) comes back as an
// empty array rather than failing the whole import.
export async function parseFullTargetAccountsWorkbook(arrayBuffer) {
  const zip = ZipReader.fromArrayBuffer(arrayBuffer);
  const workbookXml = await zip.readText("xl/workbook.xml");
  const relsXml = await zip.readText("xl/_rels/workbook.xml.rels");
  const sharedStrings = zip.has("xl/sharedStrings.xml")
    ? parseSharedStrings(await zip.readText("xl/sharedStrings.xml"))
    : [];

  const result = {};
  for (const [key, sheetNameCandidates] of Object.entries(RELATIONAL_SHEETS)) {
    let sheetPath = null;
    for (const candidate of sheetNameCandidates) {
      sheetPath = resolveSheetPath(workbookXml, relsXml, candidate);
      if (sheetPath) break;
    }
    result[key] = sheetPath ? parseGenericSheetRows(await zip.readText(sheetPath), sharedStrings) : [];
  }
  return result;
}
