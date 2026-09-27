/**
 * PDF text extraction, in the browser.
 *
 * The API deliberately does not parse PDFs. A dependency-free PHP extractor
 * would mean reimplementing Flate streams and font encodings badly, while the
 * browser already ships a good parser — and doing it here costs the server no
 * CPU, works with every AI provider (not only the ones that accept PDF
 * uploads), and keeps the file itself out of the AI request entirely.
 *
 * pdf.js is imported lazily so its ~400KB never lands in the main bundle for
 * the people who only ever paste text.
 */

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      // ?url makes Vite emit the worker as its own asset and hand back a path
      // that already carries the app's /smashcards/ base.
      const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/**
 * @param {File} file
 * @param {(page: number, total: number) => void} [onProgress]
 * @returns {Promise<string>} the document's text, empty when there is no text layer
 */
export async function extractPdfText(file, onProgress) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());

  // Teardown lives on the loading task, not on the document it resolves to —
  // PDFDocumentProxy has no destroy() of its own, so holding only the document
  // leaves the worker running and throws when you try to shut it down.
  const task = pdfjs.getDocument({ data, isEvalSupported: false });

  // A password-protected or corrupt file rejects here; the caller turns that
  // into a message rather than letting it surface as a stack trace.
  const doc = await task.promise;

  try {
    const pages = [];

    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      pages.push(pageText(content.items));
      // Releases the page's own buffers; a 300-page document otherwise keeps
      // every page it has touched alive until the whole document is destroyed.
      page.cleanup?.();
      onProgress?.(number, doc.numPages);
    }

    return tidy(pages.join('\n\n'));
  } finally {
    // Never let a teardown problem mask the text we already extracted.
    await task.destroy().catch(() => {});
  }
}

/** True for a PDF with no text layer — a scan, in practice. */
export function looksLikeAScan(text) {
  return text.replace(/\s/g, '').length < 20;
}

/**
 * Renders a scanned PDF's pages to JPEGs, for the server to read as text.
 *
 * Rendering happens here because the browser already has the PDF decoded; the
 * alternative would be shipping a PDF rasteriser to a PHP host that has none.
 * Width is capped rather than fixed by a scale factor, so an A4 page and a
 * poster both arrive at a size the model can read without one of them becoming
 * a needlessly expensive image.
 *
 * @param {File} file
 * @param {number} maxPages
 * @param {(page: number, total: number) => void} [onProgress]
 * @returns {Promise<Blob[]>}
 */
export async function renderPdfPages(file, maxPages, onProgress) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;

  try {
    const total = Math.min(doc.numPages, maxPages);
    const images = [];

    for (let number = 1; number <= total; number += 1) {
      const page = await doc.getPage(number);
      const unscaled = page.getViewport({ scale: 1 });
      // 1600px wide is comfortably legible for body text without pushing the
      // image into the model's higher-cost tier for no extra accuracy.
      const viewport = page.getViewport({ scale: Math.min(2, 1600 / unscaled.width) });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;

      images.push(await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.82);
      }));

      // Frees the backing store immediately; twenty full-page canvases held at
      // once is enough to be killed on a phone.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup?.();

      onProgress?.(number, total);
    }

    return images.filter(Boolean);
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** How many pages the file has, without rendering any of them. */
export async function countPdfPages(file) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, isEvalSupported: false });

  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy().catch(() => {});
  }
}

function pageText(items) {
  let out = '';

  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    out += item.str;
    // pdf.js marks the end of a visual line rather than emitting a newline.
    if (item.hasEOL) out += '\n';
  }

  return out;
}

function tidy(text) {
  return text
    // A word split across a line break by hyphenation is one word again.
    .replace(/(\w)-\n(\w)/g, '$1$2')
    // A single newline inside a paragraph is a line wrap, not a break.
    .replace(/([^\n])\n(?![\n\s])/g, '$1 ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
