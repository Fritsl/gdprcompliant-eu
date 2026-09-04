import PDFDocument from 'pdfkit';
import type { TimelineModel } from './timeline.js';

// The accountability record as a dated PDF (C-02): who did what, when, on this case,
// with the date it was produced on every page. Standard fonts only, so nothing is
// fetched and the file is the same wherever it is generated.

export interface TimelinePdfOptions {
  readonly title: string;
  readonly generatedAt: Date;
  readonly generatedLabel: string;
  readonly pageLabel: (page: number, pages: number) => string;
  // Off in tests so the text can be read back; on everywhere else.
  readonly compress?: boolean;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function timelinePdf(model: TimelineModel, options: TimelinePdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      bufferPages: true,
      compress: options.compress ?? true,
      info: {
        Title: `${options.title} ${model.caseId}`,
        Producer: 'GDPRcompliant.eu',
        CreationDate: options.generatedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).text(`${options.title} · ${model.caseId}`);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#555555')
      .text(`${options.generatedLabel} ${day(options.generatedAt)}`)
      .fillColor('#000000')
      .moveDown(1.5);

    for (const e of model.entries) {
      doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`${e.when} · ${e.actor}`);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(e.text);
      if (e.detail) doc.font('Helvetica').fontSize(10).text(e.detail);
      doc.moveDown(0.8);
    }
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(8.5).fillColor('#555555').text(model.disclaimer);

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#555555')
        .text(
          `${model.caseId} · ${day(options.generatedAt)} · ${options.pageLabel(i - range.start + 1, range.count)}`,
          56,
          doc.page.height - 40,
          { lineBreak: false },
        );
    }
    doc.end();
  });
}
