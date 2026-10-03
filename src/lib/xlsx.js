const zlib = require("zlib");

// A small reader for Excel .xlsx files (no dependency): an .xlsx is a zip of
// XML parts. Reads every worksheet's cells as text (numbers as Excel stores
// them, dates as YYYY-MM-DD) so imports treat a spreadsheet like a CSV.

const MAX_UNZIPPED = 60 * 1024 * 1024;

/** Zip entries by name → Buffer (deflate or stored). */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not an .xlsx file (no zip directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged .xlsx file");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|workbook\.xml|styles\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue;
    total += size;
    if (total > MAX_UNZIPPED) throw new Error("spreadsheet is too large");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    files.set(name, method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED }));
  }
  return files;
}

const unescape = (s) => s.replace(/&(lt|gt|quot|apos|amp|#x?[0-9a-fA-F]+);/g, (_, e) => {
  if (e === "lt") return "<";
  if (e === "gt") return ">";
  if (e === "quot") return '"';
  if (e === "apos") return "'";
  if (e === "amp") return "&";
  return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});

/** Text of every <t> inside a string item (rich text has several runs). */
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => unescape(m[1] || "")).join("");

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Which cell styles are dates (so serial numbers become YYYY-MM-DD). */
function dateStyles(xml) {
  if (!xml) return new Set();
  const custom = new Map([...xml.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), unescape(m[2])]));
  const isDate = (id) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (custom.has(id) && /[dy]/i.test(custom.get(id).replace(/\[[^\]]*\]|"[^"]*"/g, "")));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  const out = new Set();
  if (!xfs) return out;
  [...xfs[1].matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)].forEach((m, i) => isDate(Number(m[1])) && out.add(i));
  return out;
}

function serialToDate(n) {
  const ms = Math.round((Number(n) - 25569) * 86400000); // 1900 date system
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(n) : d.toISOString().slice(0, 10);
}

/** Sheets as { name, rows: string[][] } in workbook order. */
function readXlsx(buf) {
  const files = unzip(buf);
  const shared = files.has("xl/sharedStrings.xml")
    ? [...files.get("xl/sharedStrings.xml").toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];
  const dates = dateStyles(files.get("xl/styles.xml") && files.get("xl/styles.xml").toString("utf8"));
  const wb = (files.get("xl/workbook.xml") || Buffer.from("")).toString("utf8");
  const rels = (files.get("xl/_rels/workbook.xml.rels") || Buffer.from("")).toString("utf8");
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [(/Id="([^"]+)"/.exec(m[0]) || [])[1], (/Target="([^"]+)"/.exec(m[0]) || [])[1]]));
  let order = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: unescape((/name="([^"]*)"/.exec(m[0]) || [])[1] || "Sheet"),
    file: `xl/${String(target.get((/r:id="([^"]+)"/.exec(m[0]) || [])[1]) || "").replace(/^\/?xl\//, "")}`,
  })).filter((s) => files.has(s.file));
  if (!order.length) order = [...files.keys()].filter((k) => k.startsWith("xl/worksheets/")).sort().map((file, i) => ({ name: `Sheet${i + 1}`, file }));
  return order.map(({ name, file }) => {
    const xml = files.get(file).toString("utf8");
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const body = cm[2] || "";
        const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
        const idx = ref ? colIndex(ref) : row.length;
        const type = (/\bt="(\w+)"/.exec(attrs) || [])[1];
        const style = Number((/\bs="(\d+)"/.exec(attrs) || [])[1] || 0);
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = textOf(body);
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (type === "str" || type === "e") value = unescape(v || "");
        else if (v !== undefined) value = dates.has(style) ? serialToDate(v) : String(Number(v));
        row[idx] = value.trim();
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = "";
      rows.push(row);
    }
    return { name, rows };
  });
}

const isXlsx = (buf) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

module.exports = { readXlsx, isXlsx };
