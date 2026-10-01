/**
 * Guesses the delimiter from the header line: Excel in many locales saves
 * "CSV" with semicolons, and copy/paste from a spreadsheet gives tabs.
 */
function sniffDelimiter(text) {
  const first = String(text).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, "");
  const counts = [",", ";", "\t"].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF. */
function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = String(text).replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Parses CSV with a header row into objects keyed by normalized header. */
function csvToObjects(text) {
  const [header, ...rows] = parseCsv(text, sniffDelimiter(text));
  if (!header) return [];
  const keys = header.map(normalizeHeader);
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

function normalizeHeader(h) {
  return h
    .trim()
    .toLowerCase()
    .replace(/\+\/-|\+-/g, "plus_minus")
    .replace(/^(#|no\.?)$/, "number")
    .replace(/[%]/g, "pct").replace(/[+/]/g, "_").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n") + "\r\n";
}

module.exports = { sniffDelimiter, parseCsv, csvToObjects, toCsv, normalizeHeader };
