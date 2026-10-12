/**
 * Minimal text-only PDF 1.4 writer (Courier, A4). Report cards are tabular
 * plain text, so this avoids a rendering dependency inside the Lambda bundle.
 * Lines: string | { text, bold }.
 */
const esc = (s) => String(s).replace(/[^\x20-\x7E]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);

const LINES_PER_PAGE = 54;

export function renderPdf(lines, { watermark = null } = {}) {
  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  // 1 catalog, 2 pages, 3 Courier, 4 Courier-Bold, then (page, content) pairs.
  const objects = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>');

  for (const [i, page] of pages.entries()) {
    const mark = watermark
      ? `q 0.85 g BT /F2 64 Tf 0.7071 0.7071 -0.7071 0.7071 120 230 Tm (${esc(watermark)}) Tj ET Q\n`
      : '';
    const body = page
      .map((l) => {
        const line = typeof l === 'string' ? { text: l } : l;
        return `${line.bold ? '/F2' : '/F1'} 10 Tf (${esc(line.text)}) Tj T*`;
      })
      .join('\n');
    const footer = `BT /F1 8 Tf 50 30 Td (Page ${i + 1} of ${pages.length}${watermark ? ` - ${esc(watermark)}` : ''}) Tj ET`;
    const stream = `${mark}BT 14 TL 50 800 Td\n${body}\nET\n${footer}`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}