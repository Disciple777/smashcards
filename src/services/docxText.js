/**
 * Word (.docx) text extraction, in the browser.
 *
 * A .docx is a ZIP archive whose `word/document.xml` holds the prose. Both
 * halves of that are things the platform can already do — `DecompressionStream`
 * inflates the entry and `DOMParser` reads the XML — so this needs no library
 * at all, the same way PDFs need no server-side parser.
 *
 * Only the modern .docx is supported. The legacy binary .doc is a completely
 * different, undocumented format; it is refused with an explanation rather than
 * half-read into mojibake.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_ENTRY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/**
 * @param {File} file
 * @returns {Promise<string>} the document's text
 */
export async function extractDocxText(file) {
  const buffer = await file.arrayBuffer();
  const xml = await readZipEntry(buffer, 'word/document.xml');

  if (xml === null) {
    throw new Error(
      'That file is not a readable Word document. If it was saved as the older '
      + '.doc format, open it in Word and save it again as .docx.',
    );
  }

  return documentXmlToText(xml);
}

export function isDocx(file) {
  return /\.docx$/i.test(file.name)
    || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

// ------------------------------------------------------------------- zip --

/**
 * Reads one entry out of a ZIP, as text.
 *
 * Deliberately minimal: it walks the central directory (the authoritative
 * index) rather than scanning for local headers, which is both faster and
 * immune to the stale sizes local headers are allowed to carry.
 *
 * @returns {Promise<string|null>} null when the archive has no such entry
 */
async function readZipEntry(buffer, wantedName) {
  const view = new DataView(buffer);
  const directoryOffset = findCentralDirectory(view);

  if (directoryOffset === null) return null;

  let cursor = directoryOffset;

  while (cursor + 46 <= view.byteLength && view.getUint32(cursor, true) === CENTRAL_ENTRY) {
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    const name = new TextDecoder().decode(new Uint8Array(buffer, cursor + 46, nameLength));

    if (name === wantedName) {
      return readLocalEntry(buffer, view, localOffset, method, compressedSize);
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return null;
}

async function readLocalEntry(buffer, view, offset, method, compressedSize) {
  if (view.getUint32(offset, true) !== LOCAL_HEADER) {
    throw new Error('That Word document appears to be damaged.');
  }

  // The local header repeats the name and extra fields, and its extra field
  // length can differ from the central one — so it must be read from here.
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;

  const data = new Uint8Array(buffer, start, compressedSize);

  // 0 = stored, 8 = deflate. Those are the only methods .docx uses in practice.
  if (method === 0) return new TextDecoder().decode(data);

  if (method !== 8) {
    throw new Error('That Word document uses a compression this browser cannot read.');
  }

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));

  return new Response(stream).text();
}

/** Scans back from the end for the end-of-central-directory record. */
function findCentralDirectory(view) {
  // The record is 22 bytes plus a comment of up to 64KB, so this is as far
  // back as it can possibly be.
  const earliest = Math.max(0, view.byteLength - 22 - 0xffff);

  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      return view.getUint32(offset + 16, true);
    }
  }

  return null;
}

// ------------------------------------------------------------------- xml --

/**
 * Turns WordprocessingML into plain text.
 *
 * Parsed rather than regexed: `<w:t>` content can contain escaped markup, and
 * a document's own prose about XML would tear a regex apart.
 */
function documentXmlToText(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('That Word document could not be read.');
  }

  const paragraphs = doc.getElementsByTagName('w:p');
  const lines = [];

  for (const paragraph of paragraphs) {
    let line = '';

    // Descendants in document order, so runs, tabs and breaks stay in sequence.
    for (const node of paragraph.getElementsByTagName('*')) {
      if (node.tagName === 'w:t') line += node.textContent;
      else if (node.tagName === 'w:tab') line += '\t';
      else if (node.tagName === 'w:br' || node.tagName === 'w:cr') line += '\n';
    }

    lines.push(line.trim());
  }

  return lines
    .join('\n')
    // Word emits an empty <w:p> for every blank line and every table cell
    // boundary; collapse runs of them into one paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
