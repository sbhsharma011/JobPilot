/**
 * resumeParser.js — shared client-side resume file reading, used by both the
 * onboarding wizard (Step 2) and the "Update Resume" section in Settings.
 *
 * Handles turning a File (PDF/DOCX/TXT/legacy DOC) into either plain text or,
 * for PDFs, a base64 blob Claude can read natively as a document block. Kept
 * as a standalone script (no bundler/module system in this extension) and
 * exposed on `window.JobPilotResume` so any page can include it with a plain
 * <script> tag before its own controller script.
 */

'use strict';

(function (global) {

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result || '');
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsText(file, 'utf-8');
    });
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // A .docx is a ZIP archive containing word/document.xml with the visible
  // text inside <w:t> elements. This reads the ZIP central directory to
  // locate that entry, decompresses it with the browser's built-in
  // DecompressionStream (no external library needed), and strips the XML
  // down to plain text.
  async function extractDocxText(arrayBuffer) {
    const buf = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);

    const EOCD_SIG = 0x06054b50;
    let eocdOffset = -1;
    const scanStart = Math.max(0, buf.length - 22 - 65536);
    for (let i = buf.length - 22; i >= scanStart; i--) {
      if (dv.getUint32(i, true) === EOCD_SIG) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) throw new Error('Not a valid DOCX (zip end-of-central-directory not found)');

    const cdOffset  = dv.getUint32(eocdOffset + 16, true);
    const cdEntries = dv.getUint16(eocdOffset + 10, true);

    const CD_SIG = 0x02014b50;
    let pos = cdOffset;
    let target = null;

    for (let i = 0; i < cdEntries; i++) {
      if (dv.getUint32(pos, true) !== CD_SIG) break;
      const compMethod        = dv.getUint16(pos + 10, true);
      const compSize          = dv.getUint32(pos + 20, true);
      const nameLen           = dv.getUint16(pos + 28, true);
      const extraLen          = dv.getUint16(pos + 30, true);
      const commentLen        = dv.getUint16(pos + 32, true);
      const localHeaderOffset = dv.getUint32(pos + 42, true);
      const name = new TextDecoder('utf-8').decode(buf.slice(pos + 46, pos + 46 + nameLen));

      if (name === 'word/document.xml') {
        target = { compMethod, compSize, localHeaderOffset };
        break;
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    if (!target) throw new Error('word/document.xml not found in DOCX');

    const LFH_SIG = 0x04034b50;
    const lfhPos = target.localHeaderOffset;
    if (dv.getUint32(lfhPos, true) !== LFH_SIG) throw new Error('Invalid DOCX local file header');
    const lfhNameLen  = dv.getUint16(lfhPos + 26, true);
    const lfhExtraLen = dv.getUint16(lfhPos + 28, true);
    const dataStart   = lfhPos + 30 + lfhNameLen + lfhExtraLen;
    const compressedData = buf.slice(dataStart, dataStart + target.compSize);

    let xmlBytes;
    if (target.compMethod === 0) {
      xmlBytes = compressedData;
    } else if (target.compMethod === 8) {
      const stream = new Blob([compressedData]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      xmlBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error(`Unsupported DOCX compression method: ${target.compMethod}`);
    }

    const xml = new TextDecoder('utf-8').decode(xmlBytes);

    let text = '';
    for (const para of xml.split(/<\/w:p>/)) {
      const paraText = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
      if (paraText) text += paraText + '\n';
    }
    return text.trim();
  }

  const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
  const MAX_TEXT_CHARS = 8000;            // cap sent to storage / Claude

  /**
   * Reads a resume File and returns either extracted plain text or, for
   * PDFs, a base64 blob for Claude to read natively (no lossy client-side
   * PDF text extraction).
   *
   * @returns {Promise<{resumeText: string, pdfBase64: string|null}>}
   * @throws {Error} with a user-facing message ("File too large...", etc.)
   */
  async function readResumeFile(file) {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error('File too large (max 5 MB).');
    }

    const isPdf  = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || /\.docx$/i.test(file.name);
    const isTxt  = file.type === 'text/plain' || /\.txt$/i.test(file.name);

    let resumeText = '';
    let pdfBase64  = null;

    if (isTxt) {
      resumeText = await file.text();
    } else if (isPdf) {
      pdfBase64 = arrayBufferToBase64(await file.arrayBuffer());
    } else if (isDocx) {
      try {
        resumeText = await extractDocxText(await file.arrayBuffer());
      } catch (err) {
        console.warn('[JobPilot] DOCX text extraction failed:', err);
        resumeText = await readFileAsText(file);
      }
    } else {
      // Legacy .doc (pre-2007 binary format) — no reliable client-side
      // parser without a heavy library. Best-effort fallback only.
      resumeText = await readFileAsText(file);
    }

    return {
      resumeText: (resumeText || '').slice(0, MAX_TEXT_CHARS),
      pdfBase64,
    };
  }

  global.JobPilotResume = {
    readFileAsText,
    arrayBufferToBase64,
    extractDocxText,
    readResumeFile,
    MAX_FILE_BYTES,
    MAX_TEXT_CHARS,
  };

})(typeof window !== 'undefined' ? window : globalThis);
