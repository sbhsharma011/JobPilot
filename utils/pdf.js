/**
 * pdf.js — minimal, dependency-free PDF generator for the "Download PDF"
 * button on the generated cover letter.
 *
 * Builds a valid PDF 1.4 file by hand using the Base-14 Helvetica font
 * (no font embedding needed — every PDF viewer ships it) so there's no
 * external library to load, which the extension's `script-src 'self'` CSP
 * wouldn't allow anyway.
 */

'use strict';

const PDF_PAGE_WIDTH  = 612; // US Letter, points (72pt = 1in)
const PDF_PAGE_HEIGHT = 792;
const PDF_MARGIN      = 72;  // 1 inch margins
const PDF_FONT_SIZE   = 11;
const PDF_LINE_HEIGHT = 15;

// "Smart" punctuation Claude commonly produces → WinAnsiEncoding single-byte
// codes (Helvetica base-14 covers these via /Encoding /WinAnsiEncoding).
// Anything else outside ASCII falls back to "?" rather than corrupting the file.
const WINANSI_MAP = {
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
  '–': 0x96, '—': 0x97, '…': 0x85, ' ': 0x20,
};

function encodeWinAnsi(str) {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 128) out += ch;
    else if (WINANSI_MAP[ch] !== undefined) out += String.fromCharCode(WINANSI_MAP[ch]);
    else out += '?';
  }
  return out;
}

function escapePdfString(str) {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Word-wrap using the browser's own font metrics (canvas measureText at
// "Npx" numerically equals the PDF's rendered width at "Npt" for the same
// string — both are just linear scalings of the font's unitless glyph
// widths by N). A small safety margin absorbs Helvetica→Arial substitution
// differences on non-Mac systems.
function wrapTextToLines(text, maxWidth, fontSize) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px Helvetica, Arial, sans-serif`;
  const wrapWidth = maxWidth * 0.95;

  const lines = [];
  for (const para of text.split('\n')) {
    if (para.trim() === '') { lines.push(''); continue; }
    const words = para.split(' ');
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (current && ctx.measureText(test).width > wrapWidth) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function paginateLines(lines) {
  const usableHeight = PDF_PAGE_HEIGHT - PDF_MARGIN * 2;
  const linesPerPage = Math.max(1, Math.floor(usableHeight / PDF_LINE_HEIGHT));
  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  return pages.length ? pages : [[]];
}

function buildContentStream(lines) {
  const y = PDF_PAGE_HEIGHT - PDF_MARGIN;
  let stream = `BT\n/F1 ${PDF_FONT_SIZE} Tf\n${PDF_LINE_HEIGHT} TL\n${PDF_MARGIN} ${y} Td\n`;
  lines.forEach((line, idx) => {
    const escaped = escapePdfString(encodeWinAnsi(line));
    stream += idx === 0 ? `(${escaped}) Tj\n` : `T*\n(${escaped}) Tj\n`;
  });
  stream += 'ET';
  return stream;
}

function buildPdfBytes(pages) {
  let objNum = 1;
  const catalogNum = objNum++;
  const pagesNum   = objNum++;
  const fontNum    = objNum++;
  const pageNums    = [];
  const contentNums = [];
  for (let i = 0; i < pages.length; i++) {
    pageNums.push(objNum++);
    contentNums.push(objNum++);
  }

  const objs = new Array(objNum);
  objs[catalogNum] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
  objs[pagesNum]   = `<< /Type /Pages /Kids [${pageNums.map(n => n + ' 0 R').join(' ')}] /Count ${pageNums.length} >>`;
  objs[fontNum]    = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

  pageNums.forEach((pn, i) => {
    objs[pn] = `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] `
      + `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`;
  });

  contentNums.forEach((cn, i) => {
    objs[cn] = { stream: buildContentStream(pages[i]) };
  });

  let pdf = '%PDF-1.4\n';
  const offsets = new Array(objs.length).fill(0);

  for (let n = 1; n < objs.length; n++) {
    offsets[n] = pdf.length;
    const obj = objs[n];
    if (obj && typeof obj === 'object') {
      pdf += `${n} 0 obj\n<< /Length ${obj.stream.length} >>\nstream\n${obj.stream}\nendstream\nendobj\n`;
    } else {
      pdf += `${n} 0 obj\n${obj}\nendobj\n`;
    }
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) {
    pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  // Every character in `pdf` is guaranteed < 256 (PDF syntax is ASCII; page
  // content went through encodeWinAnsi/escapePdfString) so a 1:1 charCode →
  // byte mapping is correct here — this must NOT go through TextEncoder,
  // which would UTF-8 multi-byte encode anything above 127 and corrupt
  // both byte offsets and the WinAnsi-encoded text.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xFF;
  return bytes;
}

function downloadTextAsPdf(text, filename) {
  const maxWidth = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
  const lines = wrapTextToLines(text, maxWidth, PDF_FONT_SIZE);
  const pages = paginateLines(lines);
  const bytes = buildPdfBytes(pages);

  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
