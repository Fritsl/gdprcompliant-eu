import PDFDocument from 'pdfkit';
import { fillTemplate, type ReportModel } from './report.js';

// The status report as a PDF (V-01). Black and greys only, standard fonts only, the
// generation date and the live case address on every page. Nothing in here depends on
// the clock or on randomness: the same model gives the same bytes.

export interface ReportPdfOptions {
  // Off in tests so the text can be read back; on everywhere else.
  readonly compress?: boolean;
}

const INK = '#000000';
const MUTED = '#555555';
const RULE = '#999999';
const MARGIN = 56;

export function reportPdf(model: ReportModel, options: ReportPdfOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      compress: options.compress ?? true,
      info: {
        Title: `${model.title} ${model.caseId}`,
        Producer: 'GDPRcompliant.eu',
        CreationDate: new Date(0),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - MARGIN * 2;
    const bottom = doc.page.height - MARGIN - 24;
    const room = (needed: number) => {
      if (doc.y + needed > bottom) doc.addPage();
    };
    const rule = () => {
      doc
        .moveTo(MARGIN, doc.y)
        .lineTo(MARGIN + width, doc.y)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      doc.moveDown(0.4);
    };
    const heading = (text: string) => {
      room(60);
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(text);
      doc.moveDown(0.3);
    };

    // Head.
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(model.caseId);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(model.title);
    doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(model.subject);
    doc.moveDown(0.4);
    doc
      .fontSize(9)
      .text(`${model.generatedLabel} ${model.generated}`)
      .text(model.standing)
      .text(`${model.liveLabel}: ${model.caseUrl}`);
    doc.moveDown(0.6);
    rule();

    // Where things stand.
    heading(model.sections.standing);
    doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(model.summary);
    doc.moveDown(0.5);
    const cols = [0, 110, 210];
    const cell = (x: number, w: number, text: string, bold = false) =>
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9.5)
        .text(text, MARGIN + x, doc.y, { width: w, continued: false });
    const row = (a: string, b: string, c: string, bold: boolean, muted = false) => {
      room(24);
      const y = doc.y;
      doc.fillColor(muted ? MUTED : INK);
      cell(cols[0]!, cols[1]! - cols[0]! - 6, a, bold);
      const y1 = doc.y;
      doc.y = y;
      cell(cols[1]!, cols[2]! - cols[1]! - 6, b, bold);
      const y2 = doc.y;
      doc.y = y;
      cell(cols[2]!, width - cols[2]!, c, false);
      doc.y = Math.max(doc.y, y1, y2) + 3;
      doc.x = MARGIN;
    };
    row(model.columns.area, model.columns.status, model.columns.latest, true, true);
    for (const r of model.matrix) {
      // The state is words, and the mark beside it is a shape, so it reads in greyscale:
      // a filled square for open, a tick for in order, a question mark for not determined.
      const mark = r.state === 'open' ? '■' : r.state === 'done' ? '✓' : '?';
      row(r.areaLabel, `${mark} ${r.stateLabel}`, r.note, r.state === 'open');
    }
    doc.moveDown(0.3);
    rule();

    // What needs doing.
    heading(model.sections.actions);
    if (model.actions.length === 0) {
      doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(model.sections.nothingToDo);
    } else {
      const acols = [0, 26, 330, 440];
      const arow = (n: string, what: string, who: string, effort: string, bold: boolean) => {
        room(28);
        const y = doc.y;
        doc.fillColor(bold ? MUTED : INK);
        const ys: number[] = [];
        for (const [x, w, text] of [
          [acols[0]!, acols[1]! - 4, n],
          [acols[1]!, acols[2]! - acols[1]! - 8, what],
          [acols[2]!, acols[3]! - acols[2]! - 8, who],
          [acols[3]!, width - acols[3]!, effort],
        ] as const) {
          doc.y = y;
          cell(x, w, text, bold);
          ys.push(doc.y);
        }
        doc.y = Math.max(...ys) + 3;
        doc.x = MARGIN;
      };
      arow('', model.columns.action, model.columns.who, model.columns.effort, true);
      for (const a of model.actions)
        arow(`${a.n}.`, `${a.what} (${a.ref})`, a.who, a.effort, false);
    }
    doc.moveDown(0.3);
    rule();

    // The questions the advisor answered (V-02), each in its three parts.
    if (model.advice.length > 0) {
      heading(model.sections.advice);
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(model.sections.adviceLead);
      doc.moveDown(0.4);
      const inset = (text: string, bold = false) =>
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(bold ? 9 : 9.5)
          .fillColor(INK)
          .text(text, MARGIN + 14, doc.y, { width: width - 14 });
      for (const a of model.advice) {
        room(80);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(a.question);
        inset(a.refused ? `${model.sections.adviceRefused} ${a.refused}` : a.answer);
        if (a.settle) inset(`${model.sections.adviceSettle}: ${a.settle}`);
        if (a.caseSays.length > 0) {
          inset(model.sections.adviceCase, true);
          for (const f of a.caseSays) inset(`• ${f.label}: ${f.value} (${f.pointer})`);
        }
        if (a.lawSays.length > 0) {
          inset(model.sections.adviceLaw, true);
          for (const l of a.lawSays) inset(`• ${l.reference}: “${l.quote}”`);
        }
        doc.x = MARGIN;
        doc.moveDown(0.6);
      }
      doc.moveDown(0.3);
      rule();
    }

    // The law, in full.
    heading(model.sections.law);
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(model.sections.quoted);
    doc.moveDown(0.4);
    if (model.articles.length === 0) {
      doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(model.sections.noLaw);
    }
    for (const a of model.articles) {
      room(80);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(a.reference);
      doc
        .font('Helvetica')
        .fontSize(9.5)
        .fillColor(INK)
        .text(a.text, MARGIN + 14, doc.y, { width: width - 14 });
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .text(`${a.sourceLabel}: ${a.sourceUrl} · ${a.corpusVersion}`, MARGIN + 14, doc.y, {
          width: width - 14,
        });
      doc.x = MARGIN;
      doc.moveDown(0.6);
    }
    if (model.decisions.length > 0) {
      heading(model.sections.decisions);
      for (const d of model.decisions) {
        room(30);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(d.reference);
        doc.font('Helvetica').fontSize(9.5).text(d.title);
        doc.moveDown(0.3);
      }
    }
    doc.moveDown(0.6);
    rule();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(model.disclaimer);

    // Every page carries the case, the date and the live address.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `${model.caseId} · ${model.generated} · ${model.caseUrl} · ${fillTemplate(model.page, { p: i - range.start + 1, n: range.count })}`,
          MARGIN,
          doc.page.height - 40,
          { lineBreak: false },
        );
    }
    doc.end();
  });
}
