/**
 * fileThumbnail.js — Sam Cafe server
 * -----------------------------------
 * Generates a real, rendered thumbnail image of a document's first
 * page, for PDF and DOCX uploads (ID proof, bonafide, training
 * certificates, compliance documents, etc). Called once at
 * upload/save time — not re-rendered on every page view — so the
 * result is cached alongside the original file.
 *
 * REQUIRED SYSTEM DEPENDENCY — LibreOffice
 * -----------------------------------------
 * DOCX (and any other office format) is converted to PDF first via
 * LibreOffice's headless CLI (`soffice --headless --convert-to pdf`),
 * then the resulting PDF's first page is rasterized the same way a
 * native PDF upload is. This means the HOST running this server must
 * have LibreOffice installed and the `soffice` binary on PATH:
 *
 *   Debian/Ubuntu:  sudo apt-get install -y libreoffice
 *   macOS (brew):   brew install --cask libreoffice
 *   Docker:         FROM node:20 ... RUN apt-get update && apt-get install -y libreoffice
 *
 * There is no reliable pure-JS way to lay out and rasterize a DOCX
 * page — DOCX has no fixed page geometry until a real layout engine
 * (Word/LibreOffice) paginates it — so this dependency is required
 * for DOCX thumbnails specifically. PDF thumbnails work without
 * LibreOffice (pdfjs-dist + @napi-rs/canvas only).
 *
 * REQUIRED NPM PACKAGES (add to package.json, then `npm install`):
 *   "pdfjs-dist": "^6.3.289"        — PDF parsing/rendering (Node build)
 *   "@napi-rs/canvas": "^1.0.9"     — native <canvas> for Node, no system Cairo/Pango needed
 *   "libreoffice-convert": "^1.8.2" — thin wrapper that shells out to `soffice`
 *
 * WHAT THIS FILE COULD NOT BE VERIFIED AGAINST
 * -----------------------------------------------
 * This module was written without a running Node process, a real
 * LibreOffice install, or a real PDF/DOCX file to test against — it
 * cannot be executed in the sandbox this was authored in. The pdfjs
 * Node rendering pattern below (NodeCanvasFactory + legacy build
 * entry point) is pdfjs's documented, standard approach for
 * server-side rendering, but pdfjs's Node/canvas integration API has
 * changed across major versions before, so after `npm install`,
 * PLEASE test this against one real PDF and one real DOCX upload
 * before relying on it in production, and check the installed
 * pdfjs-dist version's own Node examples
 * (node_modules/pdfjs-dist/examples/node/) if the canvas factory
 * shape below doesn't match.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const THUMBNAIL_WIDTH = 480; // px — "larger" per the explicit request; still small enough to store as a compact JPEG data URL
const THUMBNAIL_JPEG_QUALITY = 0.72;

/**
 * True for any mime type this module can generate a thumbnail for.
 * Images are handled separately (the browser can preview those
 * directly — see FilePreviewLink.js on the admin side) so this only
 * covers the "needs real rendering" formats.
 */
function isThumbnailableDocument(mimeType) {
  if (!mimeType) return false;
  return (
    mimeType === "application/pdf" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || // .docx
    mimeType === "application/msword" // legacy .doc — LibreOffice handles this too
  );
}

/**
 * Renders the first page of a PDF (given as a Buffer) to a JPEG data
 * URL, `THUMBNAIL_WIDTH` px wide, preserving the page's aspect ratio.
 */
async function renderPdfFirstPageToDataUrl(pdfBuffer) {
  // Lazy-required so a server that never touches documents/staff
  // uploads doesn't pay pdfjs's ~35MB module-load cost on every boot.
  const { getDocument } = require("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = require("@napi-rs/canvas");

  const loadingTask = getDocument({
    data: new Uint8Array(pdfBuffer),
    // Server-side: no browser worker thread available, and we only
    // ever render one page of one document per call, so disabling
    // the dedicated worker (main-thread rendering) is the standard
    // Node approach — see pdfjs-dist/examples/node/.
    disableWorker: true,
    isEvalSupported: false,
    // Without this, pdfjs throws "Ensure that the standardFontDataUrl
    // API parameter is provided" the moment a page uses one of the 14
    // standard PDF fonts (Helvetica, Times, etc — extremely common),
    // since in a browser it would normally fetch these from the
    // pdf.js web build's own static assets; in Node there's no
    // implicit base URL to resolve that against, so it has to be
    // pointed at the copy pdfjs-dist ships in its own package.
    //
    // pdfjs's internal validation (getFactoryUrlProp in pdf.mjs) does
    // a literal `val.endsWith("/")` check on this string — it is NOT
    // parsed as an actual URL despite the "Url" in the option name.
    // path.join() on Windows produces backslash separators, so the
    // path ends in "\" there, which fails that check with "Invalid
    // factory url: ... must include trailing slash." even though a
    // trailing separator IS present — just the wrong character.
    // Building the string with a literal forward slash side-steps
    // path.join()'s OS-specific separator entirely, since this needs
    // to satisfy a string check, not resolve to an OS path directly.
    standardFontDataUrl:
      path.dirname(require.resolve("pdfjs-dist/package.json")).replace(/\\/g, "/") + "/standard_fonts/",
  });

  try {
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = THUMBNAIL_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext("2d");

    await page.render({ canvasContext: context, viewport }).promise;

    return canvas.toDataURL("image/jpeg", THUMBNAIL_JPEG_QUALITY);
  } finally {
    // Cleanup lives on the loadingTask, not the resolved document —
    // pdfDoc.destroy() does not exist on this pdfjs-dist version's
    // Node document object (verified against the actual installed
    // package; the resolved doc only exposes .cleanup()).
    await loadingTask.destroy();
  }
}

/**
 * Converts a DOCX/DOC Buffer to PDF via headless LibreOffice, then
 * renders that PDF's first page the same way renderPdfFirstPageToDataUrl
 * does. Requires the `soffice` binary on PATH — see the file-level
 * comment above.
 */
async function renderOfficeDocFirstPageToDataUrl(docBuffer) {
  const libreConvert = require("libreoffice-convert");

  // libreoffice-convert shells out to `soffice`, which needs to write
  // its own temp profile/lock files — give it an isolated tmp dir per
  // conversion so concurrent uploads can't collide on the same
  // LibreOffice user profile lock.
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "samcafe-docx-"));
  try {
    // libreConvert.convert() is callback-only — it does NOT deliver
    // its result through the Promise it happens to return (that
    // Promise comes from its own internal orchestration and resolves
    // independently of the callback; awaiting it directly silently
    // produces `undefined` instead of the converted PDF, and calling
    // convert() with no callback throws "callback is not a function"
    // since the callback is unconditionally invoked internally).
    // Wrapped manually (rather than via util.promisify, which Node
    // flags as likely-a-mistake here purely because of that
    // orphaned internal Promise, even though the callback contract
    // itself is the real and only correct way to get the result).
    const pdfBuffer = await new Promise((resolve, reject) => {
      libreConvert.convert(docBuffer, ".pdf", undefined, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
    return await renderPdfFirstPageToDataUrl(pdfBuffer);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => { });
  }
}

/**
 * Main entry point. Given a file's mime type and its data as either a
 * `data:...;base64,...` URL (the convention used everywhere in this
 * app) or a raw Buffer, returns a JPEG data-URL thumbnail of its
 * first page, or `null` if the type isn't thumbnailable or rendering
 * failed (failure is non-fatal by design — see the call sites in
 * documents.js / staffs.js: a missing thumbnail should never block
 * saving the underlying file).
 */
async function generateFirstPageThumbnail(fileType, fileDataUrlOrBuffer) {
  if (!isThumbnailableDocument(fileType) || !fileDataUrlOrBuffer) return null;

  let buffer;
  if (Buffer.isBuffer(fileDataUrlOrBuffer)) {
    buffer = fileDataUrlOrBuffer;
  } else {
    const commaIndex = fileDataUrlOrBuffer.indexOf(",");
    const base64Part = commaIndex >= 0 ? fileDataUrlOrBuffer.slice(commaIndex + 1) : fileDataUrlOrBuffer;
    buffer = Buffer.from(base64Part, "base64");
  }

  try {
    if (fileType === "application/pdf") {
      return await renderPdfFirstPageToDataUrl(buffer);
    }
    return await renderOfficeDocFirstPageToDataUrl(buffer);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[fileThumbnail] failed to render preview (${fileType}):`, err.message);
    return null;
  }
}

module.exports = {
  isThumbnailableDocument,
  generateFirstPageThumbnail,
  THUMBNAIL_WIDTH,
};