'use strict';

/**
 * Small RFC 4180 CSV reader/writer. Deliberately dependency-free — a spreadsheet
 * export is simple enough that pulling in a parser is not worth the supply chain.
 * Handles quoted fields, escaped quotes, embedded commas and newlines, and both
 * CRLF and LF line endings.
 */

function parse(text) {
  // Strip a UTF-8 BOM, which Excel adds and which otherwise corrupts the first header.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Flush whatever the last line left behind.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Parse into objects keyed by a normalised header name. */
function parseObjects(text) {
  const rows = parse(text);
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const records = rows.slice(1).map((cells, index) => {
    const obj = { _line: index + 2 }; // +2: 1-based, and past the header row
    headers.forEach((h, c) => {
      obj[h] = (cells[c] === undefined ? '' : cells[c]).trim();
    });
    return obj;
  });

  return { headers, records };
}

function escapeField(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function stringify(headers, rows) {
  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parse, parseObjects, stringify };
