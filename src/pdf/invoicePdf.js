const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const DOC_TITLES = {
  "01": "FACTURA ELECTRÓNICA",
  "02": "NOTA DE DÉBITO ELECTRÓNICA",
  "03": "NOTA DE CRÉDITO ELECTRÓNICA",
  "04": "TIQUETE ELECTRÓNICO",
};

const SALE_CONDITIONS = {
  "01": "Contado",
  "02": "Crédito",
  "03": "Consignación",
  "04": "Apartado",
};

const PAYMENT_METHODS = {
  "01": "Efectivo",
  "02": "Tarjeta",
  "03": "Cheque",
  "04": "Transferencia / SINPE",
};

function money(val, currency = "CRC") {
  const sym = currency === "USD" ? "$" : "₡";
  return `${sym}${Number(val || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function generateInvoicePdfBuffer({ emitter, invoice, lines }) {
  const qrDataUrl = await QRCode.toDataURL(
    `https://tribunet.hacienda.go.cr/consulta/${invoice.clave}`,
    { margin: 1, width: 110 }
  );
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const title = DOC_TITLES[invoice.doc_type] || "COMPROBANTE ELECTRÓNICO";

    // Header
    doc.rect(40, 35, 532, 74).fill("#0f172a");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(16).text(emitter.name, 55, 48);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#cbd5e1")
      .text(`Cédula: ${emitter.id_number}  |  Act. Económica: ${emitter.activity_code}`, 55, 69)
      .text(`${emitter.email}  |  Tel: +${emitter.phone_country || "506"} ${emitter.phone_number}`, 55, 82)
      .text(`${emitter.address_detail}`, 55, 95);

    doc
      .fillColor("#38bdf8")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(title, 340, 48, { width: 218, align: "right" });
    doc
      .fillColor("#ffffff")
      .font("Helvetica")
      .fontSize(9)
      .text(`Consecutivo: ${invoice.consecutive}`, 340, 66, { width: 218, align: "right" })
      .text(`Fecha: ${invoice.issue_date}`, 340, 79, { width: 218, align: "right" })
      .text(`Ambiente: ${invoice.environment === "prod" ? "PRODUCCIÓN" : "SANDBOX (PRUEBAS)"}`, 340, 92, {
        width: 218,
        align: "right",
      });

    // Clave & QR
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(8.5).text("CLAVE NUMÉRICA (50 DÍGITOS):", 40, 122);
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(invoice.clave, 40, 134);
    doc.image(qrBuffer, 485, 118, { width: 82 });

    // Receptor box
    doc.roundedRect(40, 156, 430, 62, 4).stroke("#cbd5e1");
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(9).text("RECEPTOR / CLIENTE", 50, 164);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#1e293b")
      .text(`Nombre: ${invoice.client_name}`, 50, 178)
      .text(
        `Identificación: ${invoice.client_id_number || "N/A"}   |   Correo: ${invoice.client_email || "N/A"}`,
        50,
        191
      )
      .text(
        `Condición: ${SALE_CONDITIONS[invoice.sale_condition] || invoice.sale_condition}   |   Pago: ${PAYMENT_METHODS[invoice.payment_method] || invoice.payment_method}   |   Moneda: ${invoice.currency}`,
        50,
        204
      );

    let y = 232;
    if (invoice.ref_clave) {
      doc.roundedRect(40, y, 532, 34, 4).fillAndStroke("#f8fafc", "#cbd5e1");
      doc
        .fillColor("#0f172a")
        .font("Helvetica-Bold")
        .fontSize(8.5)
        .text(`REFERENCIA (${invoice.ref_doc_type}): ${invoice.ref_clave}`, 50, y + 7);
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#475569")
        .text(`Razón: ${invoice.ref_reason || "-"}`, 50, y + 19);
      y += 44;
    }

    // Table Header
    doc.rect(40, y, 532, 22).fill("#1e293b");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    doc.text("#", 46, y + 7, { width: 18 });
    doc.text("CABYS", 64, y + 7, { width: 78 });
    doc.text("DESCRIPCIÓN", 144, y + 7, { width: 165 });
    doc.text("CANT.", 312, y + 7, { width: 42, align: "right" });
    doc.text("P. UNIT.", 358, y + 7, { width: 65, align: "right" });
    doc.text("IVA", 426, y + 7, { width: 55, align: "right" });
    doc.text("TOTAL", 486, y + 7, { width: 80, align: "right" });

    y += 26;
    doc.font("Helvetica").fontSize(8.5).fillColor("#0f172a");

    for (const line of lines) {
      if (y > 670) {
        doc.addPage();
        y = 45;
      }
      doc.text(String(line.line_number), 46, y, { width: 18 });
      doc.fontSize(7.5).text(line.cabys, 64, y, { width: 78 });
      doc.fontSize(8.5).text(line.description, 144, y, { width: 165 });
      doc.text(`${Number(line.quantity)} ${line.unit}`, 312, y, { width: 42, align: "right" });
      doc.text(money(line.unit_price, invoice.currency), 358, y, { width: 65, align: "right" });
      doc.text(money(line.tax_amount, invoice.currency), 426, y, { width: 55, align: "right" });
      doc.text(money(line.line_total, invoice.currency), 486, y, { width: 80, align: "right" });
      y += 22;
      doc.moveTo(40, y - 4).lineTo(572, y - 4).stroke("#e2e8f0");
    }

    // Totals
    y += 10;
    doc.roundedRect(350, y, 222, 86, 4).fillAndStroke("#f8fafc", "#cbd5e1");
    doc.fillColor("#334155").font("Helvetica").fontSize(9);
    doc.text("Subtotal:", 362, y + 10);
    doc.text(money(invoice.subtotal, invoice.currency), 460, y + 10, { width: 100, align: "right" });

    doc.text("Descuentos:", 362, y + 26);
    doc.text(money(invoice.discount_total, invoice.currency), 460, y + 26, { width: 100, align: "right" });

    doc.text("Total IVA:", 362, y + 42);
    doc.text(money(invoice.tax_total, invoice.currency), 460, y + 42, { width: 100, align: "right" });

    doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a");
    doc.text("TOTAL:", 362, y + 62);
    doc.text(money(invoice.total, invoice.currency), 450, y + 62, { width: 110, align: "right" });

    // Status & Footer
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#0369a1")
      .text(`Estado Hacienda: ${String(invoice.status || "").toUpperCase()}`, 40, y + 12);
    if (invoice.notes) {
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor("#475569")
        .text(`Notas: ${invoice.notes}`, 40, y + 28, { width: 295 });
    }

    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor("#64748b")
      .text(
        "Autorizado mediante resolución DGT-R-033-2019 / Versión 4.4 del Ministerio de Hacienda de Costa Rica.",
        40,
        735,
        { width: 532, align: "center" }
      );

    doc.end();
  });
}

module.exports = { generateInvoicePdfBuffer };
