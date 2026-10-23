// Pure helpers shared by the content adapter (in-page UI automation) and the
// background script (cookie-authenticated export reads). Google Sheets renders
// its grid to a canvas, so the DOM never contains cell text; reading goes
// through the CSV export endpoint and writing goes through the Name Box and
// formula bar instead of pixel coordinates.

export function detectWorkspaceApp(href) {
  let url;
  try {
    url = new URL(String(href ?? ''));
  } catch {
    return null;
  }
  if (!/(^|\.)docs\.google\.com$/i.test(url.hostname)) return null;
  const path = url.pathname;

  const spreadsheet = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(path);
  if (spreadsheet) return { app: 'sheets', id: spreadsheet[1], gid: gidFromUrl(url) };
  if (/^\/spreadsheets\/(u\/\d+\/)?create\/?$/.test(path)) return { app: 'sheets', id: null, gid: null };

  const document = /^\/document\/d\/([A-Za-z0-9_-]+)/.exec(path);
  if (document) return { app: 'docs', id: document[1] };
  if (/^\/document\/(u\/\d+\/)?create\/?$/.test(path)) return { app: 'docs', id: null };

  const presentation = /^\/presentation\/d\/([A-Za-z0-9_-]+)/.exec(path);
  if (presentation) return { app: 'slides', id: presentation[1] };
  if (/^\/presentation\/(u\/\d+\/)?create\/?$/.test(path)) return { app: 'slides', id: null };

  return null;
}

export function gidFromUrl(url) {
  const hash = String(url?.hash ?? '').replace(/^#/, '');
  const fromHash = /(?:^|&)gid=(\d+)/.exec(hash);
  if (fromHash) return fromHash[1];
  const fromQuery = url?.searchParams?.get?.('gid');
  return fromQuery && /^\d+$/.test(fromQuery) ? fromQuery : '0';
}

export function columnToIndex(letters) {
  let value = 0;
  const text = String(letters ?? '').toUpperCase();
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    value = value * 26 + (code - 64);
  }
  return value > 0 ? value - 1 : -1;
}

export function indexToColumn(index) {
  let value = Number(index) + 1;
  if (!Number.isFinite(value) || value < 1) return '';
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

// A1 notation with optional sheet prefix. Returns 0-based inclusive bounds;
// null means "to the end of the sheet" for open ranges such as A:A or 1:1.
export function parseA1Range(range) {
  let text = String(range ?? '').trim();
  if (!text) return null;
  const bang = text.lastIndexOf('!');
  if (bang !== -1) text = text.slice(bang + 1);
  text = text.replace(/\$/g, '').toUpperCase();
  if (!text) return null;

  let match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(text);
  if (match) {
    const startCol = columnToIndex(match[1]);
    const startRow = Number(match[2]) - 1;
    const endCol = match[3] ? columnToIndex(match[3]) : startCol;
    const endRow = match[4] ? Number(match[4]) - 1 : startRow;
    if (startCol < 0 || endCol < 0 || startRow < 0 || endRow < 0) return null;
    return {
      startRow: Math.min(startRow, endRow),
      endRow: Math.max(startRow, endRow),
      startCol: Math.min(startCol, endCol),
      endCol: Math.max(startCol, endCol)
    };
  }

  match = /^([A-Z]+):([A-Z]+)$/.exec(text);
  if (match) {
    const startCol = columnToIndex(match[1]);
    const endCol = columnToIndex(match[2]);
    if (startCol < 0 || endCol < 0) return null;
    return {
      startRow: 0,
      endRow: null,
      startCol: Math.min(startCol, endCol),
      endCol: Math.max(startCol, endCol)
    };
  }

  match = /^(\d+):(\d+)$/.exec(text);
  if (match) {
    const startRow = Number(match[1]) - 1;
    const endRow = Number(match[2]) - 1;
    if (startRow < 0 || endRow < 0) return null;
    return {
      startRow: Math.min(startRow, endRow),
      endRow: Math.max(startRow, endRow),
      startCol: 0,
      endCol: null
    };
  }

  return null;
}

export function parseCsv(text) {
  const source = String(text ?? '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline produces one empty row; drop it so row counts match what
  // a spreadsheet actually contains.
  while (rows.length > 0 && rows[rows.length - 1].every(cell => cell === '')) rows.pop();
  return rows;
}

export function toTsv(values) {
  if (typeof values === 'string') return values;
  if (!Array.isArray(values)) return String(values ?? '');
  return values
    .map(row => (Array.isArray(row) ? row : [row])
      .map(cell => String(cell ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' '))
      .join('\t'))
    .join('\n');
}

export function normalizeMatrix(values) {
  if (typeof values === 'string') {
    const rows = values.split(/\r?\n/).map(line => line.split('\t'));
    return rows.length ? rows : [['']];
  }
  if (!Array.isArray(values)) return [[String(values ?? '')]];
  if (values.length === 0) return [['']];
  return values.map(row => (Array.isArray(row) ? row.map(cell => String(cell ?? '')) : [String(row ?? '')]));
}

export function sliceRows(rows, range) {
  if (!range) return rows;
  const startRow = range.startRow ?? 0;
  const endRow = range.endRow == null ? rows.length - 1 : Math.min(range.endRow, rows.length - 1);
  const startCol = range.startCol ?? 0;
  const endCol = range.endCol == null
    ? Math.max(0, ...rows.map(row => row.length - 1))
    : range.endCol;
  const sliced = [];
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const cells = [];
    for (let colIndex = startCol; colIndex <= endCol; colIndex += 1) {
      cells.push(row[colIndex] ?? '');
    }
    sliced.push(cells);
  }
  return sliced;
}

export function matrixSize(rows) {
  const rowCount = rows.length;
  const colCount = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  return { rowCount, colCount };
}
