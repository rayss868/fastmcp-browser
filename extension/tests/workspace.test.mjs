import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectWorkspaceApp,
  parseA1Range,
  parseCsv,
  sliceRows,
  columnToIndex,
  indexToColumn,
  normalizeMatrix,
  toTsv
} from '../src/sheet-format.js';

test('detectWorkspaceApp recognizes Sheets, Docs, and Slides document URLs', () => {
  assert.deepEqual(
    detectWorkspaceApp('https://docs.google.com/spreadsheets/d/abc123/edit?gid=42#gid=42'),
    { app: 'sheets', id: 'abc123', gid: '42' }
  );
  assert.deepEqual(
    detectWorkspaceApp('https://docs.google.com/document/d/doc999/edit?tab=t.0'),
    { app: 'docs', id: 'doc999' }
  );
  assert.deepEqual(
    detectWorkspaceApp('https://docs.google.com/presentation/d/slide1/edit'),
    { app: 'slides', id: 'slide1' }
  );
  assert.equal(detectWorkspaceApp('https://example.com/spreadsheets/d/x/edit'), null);
});

test('detectWorkspaceApp reports a null id for unsaved create URLs', () => {
  assert.deepEqual(detectWorkspaceApp('https://docs.google.com/spreadsheets/create'), { app: 'sheets', id: null, gid: null });
  assert.deepEqual(detectWorkspaceApp('https://docs.google.com/document/create'), { app: 'docs', id: null });
});

test('A1 ranges parse into 0-based inclusive bounds', () => {
  assert.deepEqual(parseA1Range('B2'), { startRow: 1, endRow: 1, startCol: 1, endCol: 1 });
  assert.deepEqual(parseA1Range('A1:D5'), { startRow: 0, endRow: 4, startCol: 0, endCol: 3 });
  assert.deepEqual(parseA1Range('Sheet1!$C$3:$E$9'), { startRow: 2, endRow: 8, startCol: 2, endCol: 4 });
  assert.deepEqual(parseA1Range('A:C'), { startRow: 0, endRow: null, startCol: 0, endCol: 2 });
  assert.deepEqual(parseA1Range('2:4'), { startRow: 1, endRow: 3, startCol: 0, endCol: null });
  assert.equal(parseA1Range('not-a-range'), null);
  assert.equal(parseA1Range(''), null);
});

test('column helpers round-trip past Z', () => {
  assert.equal(columnToIndex('A'), 0);
  assert.equal(columnToIndex('Z'), 25);
  assert.equal(columnToIndex('AA'), 26);
  assert.equal(indexToColumn(26), 'AA');
  for (const index of [0, 25, 26, 51, 52, 701, 702]) {
    assert.equal(columnToIndex(indexToColumn(index)), index);
  }
});

test('parseCsv handles quotes, escaped quotes, and embedded newlines', () => {
  const rows = parseCsv('a,b\n"one, two","say ""hi""\nnext",c\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['one, two', 'say "hi"\nnext', 'c']
  ]);
});

test('parseCsv keeps a trailing empty cell and drops a trailing empty row', () => {
  assert.deepEqual(parseCsv('a,b,\n'), [['a', 'b', '']]);
  assert.deepEqual(parseCsv('a,b\n\n'), [['a', 'b']]);
});

test('sliceRows applies A1 bounds to a matrix', () => {
  const rows = [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']];
  assert.deepEqual(sliceRows(rows, parseA1Range('B2:C3')), [['e', 'f'], ['h', 'i']]);
  assert.deepEqual(sliceRows(rows, parseA1Range('B:B')), [['b'], ['e'], ['h']]);
  assert.deepEqual(sliceRows(rows, null), rows);
});

test('normalizeMatrix accepts 2D arrays, TSV strings, and scalars', () => {
  assert.deepEqual(normalizeMatrix([['a', 1], ['b', 2]]), [['a', '1'], ['b', '2']]);
  assert.deepEqual(normalizeMatrix('a\tb\nc\td'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(normalizeMatrix(5), [['5']]);
  assert.deepEqual(normalizeMatrix([]), [['']]);
});

test('toTsv flattens rows and strips tabs/newlines inside a cell', () => {
  assert.equal(toTsv([['a', 'b'], ['c', 'd']]), 'a\tb\nc\td');
  assert.equal(toTsv([['a\tb', 'c\nd']]), 'a b\tc d');
});
