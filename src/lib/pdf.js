'use strict';
const PDFDocument = require('pdfkit');
const { formatAmount } = require('./money');
const { formatDate } = require('./dates');

// Invoices are never stored as files. The PDF is rendered on demand from the immutable invoice
// record (including the client/company snapshot taken at issue time), so every download of a
// given UID shows exactly the same content.

const NAVY = '#0b1f3a';
const RED = '#d0021b';
const GREY = '#5b6575';
const LINE = '#d9dee7';

function renderInvoicePdf(invoice, items, stream) {
  const company = JSON.parse(invoice.company_snapshot);
  const client = JSON.parse(invoice.client_snapshot);
  const issued = new Date(`${invoice.issue_date}T00:00:00Z`);

  const doc = new PDFDocument({
    size: 'A4', margin: 50, bufferPages: true,
    info: { Title: `Invoice ${invoice.uid}`, Author: company.name, Subject: `Invoice for ${client.name}`,
      CreationDate: issued, ModDate: issued },
  });
  doc.pipe(stream);

  const left = 50;
  const right = doc.page.width - 50;
  const width = right - left;

  // Accent bar
  doc.rect(0, 0, doc.page.width, 8).fill(NAVY);
  doc.rect(0, 8, doc.page.width, 3).fill(RED);

  // Company block
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text(company.name, left, 40, { width: 300 });
  doc.fillColor(RED).font('Helvetica-Oblique').fontSize(9.5).text(company.tagline || '', { width: 300 });
  doc.moveDown(0.4).fillColor(GREY).font('Helvetica').fontSize(9);
  const companyLines = [company.address, company.reg && `Business Reg. No: ${company.reg}`,
    company.phone && `Tel: ${company.phone}`, company.email, company.website].filter(Boolean);
  doc.text(companyLines.join('\n'), { width: 300, lineGap: 1.5 });
  const companyBottom = doc.y;

  // Invoice meta block
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(26).text('INVOICE', right - 200, 40, { width: 200, align: 'right' });
  const meta = [['Invoice No.', invoice.uid], ['Issue Date', formatDate(invoice.issue_date)],
    ['Due Date', formatDate(invoice.due_date)], ['Currency', invoice.currency]];
  let my = 78;
  for (const [k, v] of meta) {
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(k, right - 200, my, { width: 85 });
    doc.font('Helvetica-Bold').fillColor(NAVY).text(v, right - 115, my, { width: 115, align: 'right' });
    my += 15;
  }

  // Bill to
  let y = Math.max(companyBottom, my) + 25;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.7).strokeColor(LINE).stroke();
  y += 14;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(RED).text('BILL TO', left, y, { characterSpacing: 1 });
  y += 14;
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text(client.name, left, y, { width: 320 });
  doc.font('Helvetica').fontSize(9).fillColor(GREY);
  const clientLines = [client.contact_person && `Attn: ${client.contact_person}`, client.address,
    client.phone && `Tel: ${client.phone}`, client.email, client.tax_id && `Tax ID: ${client.tax_id}`].filter(Boolean);
  if (clientLines.length) doc.text(clientLines.join('\n'), { width: 320, lineGap: 1.5 });
  y = doc.y + 22;

  // Items table
  const amountW = 120;
  const numW = 28;
  const descW = width - amountW - numW;
  doc.rect(left, y, width, 22).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  doc.text('#', left + 8, y + 7, { width: numW - 8 });
  doc.text('DESCRIPTION', left + numW, y + 7, { width: descW - 10 });
  doc.text(`AMOUNT (${invoice.currency})`, left + numW + descW, y + 7, { width: amountW - 8, align: 'right' });
  y += 22;

  doc.font('Helvetica').fontSize(9.5);
  items.forEach((it, i) => {
    const h = Math.max(doc.heightOfString(it.description, { width: descW - 10 }), 12) + 14;
    if (y + h > doc.page.height - 190) { doc.addPage(); y = 50; }
    if (i % 2 === 1) doc.rect(left, y, width, h).fill('#f5f7fa');
    doc.fillColor(GREY).text(String(i + 1), left + 8, y + 7, { width: numW - 8 });
    doc.fillColor('#1d2533').text(it.description, left + numW, y + 7, { width: descW - 10 });
    doc.text(formatAmount(it.amount), left + numW + descW, y + 7, { width: amountW - 8, align: 'right' });
    y += h;
  });
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.7).strokeColor(LINE).stroke();

  // Totals
  y += 12;
  const tx = right - 230;
  doc.font('Helvetica').fontSize(9.5).fillColor(GREY).text('Subtotal', tx, y, { width: 110 });
  doc.fillColor('#1d2533').text(formatAmount(invoice.total), tx + 110, y, { width: 112, align: 'right' });
  y += 20;
  doc.rect(tx, y - 5, 230, 26).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text('TOTAL DUE', tx + 10, y + 3, { width: 110 });
  doc.text(`${invoice.currency} ${formatAmount(invoice.total)}`, tx + 100, y + 3, { width: 122, align: 'right' });
  y += 40;

  // Notes & payment details
  const block = (title, body) => {
    if (!body) return;
    if (y + 60 > doc.page.height - 110) { doc.addPage(); y = 50; }
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(RED).text(title, left, y, { characterSpacing: 1 });
    doc.font('Helvetica').fontSize(9).fillColor('#1d2533').text(body, left, y + 13, { width: width * 0.65, lineGap: 1.5 });
    y = doc.y + 16;
  };
  block('NOTES', invoice.notes);
  block('PAYMENT DETAILS', company.bank_details);

  // Footer (on the last page). It sits inside the bottom margin, so lift the margin while drawing
  // it — otherwise pdfkit would start a new page.
  if (y > doc.page.height - 100) { doc.addPage(); }
  doc.page.margins.bottom = 0;
  const fy = doc.page.height - 90;
  doc.moveTo(left, fy).lineTo(right, fy).lineWidth(0.7).strokeColor(LINE).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(company.footer || '', left, fy + 10, { width, align: 'center' });
  doc.font('Helvetica').fontSize(7).fillColor(GREY)
    .text(`${company.name} · ${company.reg ? `Reg. ${company.reg} · ` : ''}${invoice.uid}`, left, fy + 28, { width, align: 'center' })
    .text(`Document fingerprint (SHA-256): ${invoice.content_hash}`, left, fy + 40, { width, align: 'center' });

  // Overlays on every page, drawn last so nothing paints over them.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    if (invoice.status === 'void') {
      doc.save().rotate(-30, { origin: [doc.page.width / 2, 420] })
        .font('Helvetica-Bold').fontSize(110).fillColor(RED).fillOpacity(0.18)
        .text('VOID', 0, 360, { width: doc.page.width, align: 'center', lineBreak: false }).restore();
      doc.fillOpacity(1);
    }
    if (range.count > 1) {
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
        .text(`${invoice.uid} · Page ${i - range.start + 1} of ${range.count}`, left, doc.page.height - 30, { width, align: 'right', lineBreak: false });
    }
  }

  doc.end();
}

module.exports = { renderInvoicePdf };
