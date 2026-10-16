// 1.2.4.3 (Boaz: projects "in a 2nd tab"): the smallest .xlsx Excel opens and xlsx-lite.js reads back - one sheet per
// table, a header row, text as inline strings, numbers as numbers. No styles, no shared strings.
//
//   xlsxParts([{ name, headers, rows }])  -> [{ name, data }] for backup-zip.js createZip (a .xlsx is a zip of these)
//
// PURE - no chrome APIs, no storage, no DOM (test_pure_modules.py runs it).

// XML 1.0 allows only these characters; anything else (a stray control character in scraped text) would make Excel
// refuse the whole file.
function xmlText(value) {
  return String(value)
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 0 -> "A", 25 -> "Z", 26 -> "AA"
export function columnName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// Excel's own limits for a sheet name: at most 31 characters, none of : \ / ? * [ ]
function sheetName(name) {
  return String(name).replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";
}

function cellXml(ref, value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  // Excel keeps at most 32,767 characters in a cell.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(String(value).slice(0, 32767))}</t></is></c>`;
}

function sheetXml(headers, rows) {
  const lines = [headers, ...rows].map((cells, r) =>
    `<row r="${r + 1}">${cells.map((v, c) => cellXml(`${columnName(c)}${r + 1}`, v)).join("")}</row>`);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<sheetData>${lines.join("")}</sheetData></worksheet>`;
}

export function xlsxParts(sheets) {
  const list = sheets.map((s, i) => ({ ...s, id: i + 1, name: sheetName(s.name) }));
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    list.map((s) => `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    "</Types>";
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${list.map((s) => `<sheet name="${xmlText(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join("")}</sheets>` +
    "</workbook>";
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list.map((s) => `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`).join("") +
    "</Relationships>";
  return [
    { name: "[Content_Types].xml", data: ct },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    ...list.map((s) => ({ name: `xl/worksheets/sheet${s.id}.xml`, data: sheetXml(s.headers, s.rows) })),
  ];
}
