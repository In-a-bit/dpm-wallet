/**
 * Builds TECHNICAL-SPEC.docx (for Google Docs import) from TECHNICAL-SPEC.md.
 *
 * Two things the naive md -> html -> docx path gets wrong, both handled here:
 *
 * 1. Diagrams are rendered PNGs at 3x, far larger than a page, so each <img>
 *    is given explicit dimensions that fit an A4 text frame — LibreOffice
 *    otherwise inserts them at native pixel size and they overflow the page.
 * 2. LibreOffice *links* local image files (TargetMode="External", file:///...)
 *    instead of embedding them, which leaves broken images once the .docx is
 *    uploaded to Google Docs. Inlining each PNG as a base64 data URI forces a
 *    real embed, so the file is self-contained.
 *
 * Usage: node docs/build-docx.mjs   (requires npx + libreoffice on PATH)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = dirname(fileURLToPath(import.meta.url));
const MARKDOWN = resolve(docsDir, "TECHNICAL-SPEC.md");
const HTML = resolve(docsDir, "TECHNICAL-SPEC.html");

/** A4 portrait minus 2cm margins, at 96 DPI. */
const MAX_WIDTH_PX = 640;
const MAX_HEIGHT_PX = 850;

function readPngSize(pngPath) {
  const header = readFileSync(pngPath).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

function fitToPage({ width, height }) {
  const scale = Math.min(1, MAX_WIDTH_PX / width, MAX_HEIGHT_PX / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function embedImages(html) {
  return html.replace(/<img src="([^"]+)" alt="([^"]*)"\s*\/?>/g, (_match, src, alt) => {
    const pngPath = resolve(docsDir, src);
    const { width, height } = fitToPage(readPngSize(pngPath));
    const base64 = readFileSync(pngPath).toString("base64");
    return `<img src="data:image/png;base64,${base64}" alt="${alt}" width="${width}" height="${height}" />`;
  });
}

/**
 * LibreOffice's HTML importer largely ignores <style> rules for tables and
 * sizes them to their content, pushing wide tables past the right margin.
 * The legacy presentational attributes are honoured, so set them directly.
 */
function constrainTables(html) {
  return html.replace(/<table>/g, '<table border="1" cellpadding="3" cellspacing="0" width="100%">');
}

const STYLE = `<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; }
  code, pre { font-family: Consolas, "Courier New", monospace; font-size: 9pt; }
  pre { background: #f5f5f5; padding: 8px; }
  th, td { font-size: 9pt; }
  img { display: block; margin: 8px 0; }
</style>`;

execFileSync("npx", ["--yes", "marked", "-i", MARKDOWN, "-o", HTML, "--gfm"], { stdio: "inherit" });

const body = constrainTables(embedImages(readFileSync(HTML, "utf8")));
writeFileSync(HTML, `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body>${body}</body></html>`);

execFileSync(
  "libreoffice",
  ["--headless", "--convert-to", "docx:MS Word 2007 XML", "--outdir", docsDir, HTML],
  { stdio: "inherit" },
);

rmSync(HTML);
console.log("Built TECHNICAL-SPEC.docx");
