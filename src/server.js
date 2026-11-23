const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const { db, CERTS_DIR, getEmitterConfig, getNextSequenceAndIncrement } = require("./db");
const { buildConsecutive, buildClave } = require("./hacienda/clave");
const { buildComprobanteXml, TAX_RATE_CODE_MAP } = require("./hacienda/xmlBuilder");
const { parseP12, signXmlXadesEpes } = require("./hacienda/signer");
const { getAccessToken, sendComprobante, queryComprobanteStatus } = require("./hacienda/apiClient");
const { generateInvoicePdfBuffer } = require("./pdf/invoicePdf");

const PORT = Number(process.env.PORT || 3095);
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const upload = multer({
  dest: CERTS_DIR,
  limits: { fileSize: 5 * 1024 * 1024 },
});

function sanitizeEmitter(cfg) {
  if (!cfg) return null;
  return {
    ...cfg,
    atv_password_set: Boolean(cfg.atv_password),
    atv_password: cfg.atv_password ? "••••••••" : "",
    p12_pin_set: Boolean(cfg.p12_pin),
    p12_pin: cfg.p12_pin ? "••••" : "",
    p12_uploaded: Boolean(cfg.p12_path && fs.existsSync(cfg.p12_path)),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "auraflow-facturador", version: "4.4" });
});

app.get("/api/dashboard", (_req, res) => {
  const emitter = getEmitterConfig();
  const stats = db
    .prepare(
      `SELECT
        COUNT(*) as total_docs,
        COALESCE(SUM(CASE WHEN doc_type != '03' THEN total ELSE -total END), 0) as net_billed,
        COALESCE(SUM(CASE WHEN doc_type != '03' THEN tax_total ELSE -tax_total END), 0) as net_tax,
        SUM(CASE WHEN status = 'aceptado' THEN 1 ELSE 0 END) as accepted_count,
        SUM(CASE WHEN status IN ('enviado', 'procesando') THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status IN ('rechazado', 'error') THEN 1 ELSE 0 END) as rejected_count
      FROM invoices`
    )
    .get();
  const recent = db
    .prepare(
      "SELECT id, doc_type, clave, consecutive, issue_date, client_name, currency, total, status FROM invoices ORDER BY id DESC LIMIT 8"
    )
    .all();

  res.json({
    environment: emitter.environment,
    emitterName: emitter.name,
    p12Ready: Boolean(emitter.p12_path && fs.existsSync(emitter.p12_path)),
    atvReady: Boolean(emitter.atv_username && emitter.atv_password),
    stats,
    recent,
  });
});

// === EMISOR & CERTIFICADO .P12 ===
app.get("/api/emitter", (_req, res) => {
  res.json(sanitizeEmitter(getEmitterConfig()));
});

app.put("/api/emitter", (req, res) => {
  const b = req.body || {};
  const current = getEmitterConfig();
  const nextAtvPass = b.atv_password && b.atv_password !== "••••••••" ? b.atv_password : current.atv_password;

  db.prepare(`
    UPDATE emitter_config SET
      environment = ?, name = ?, commercial_name = ?, id_type = ?, id_number = ?,
      activity_code = ?, email = ?, phone_country = ?, phone_number = ?,
      province = ?, canton = ?, district = ?, address_detail = ?,
      branch = ?, terminal = ?, atv_username = ?, atv_password = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(
    b.environment === "prod" ? "prod" : "sandbox",
    b.name || current.name,
    b.commercial_name ?? current.commercial_name,
    b.id_type || current.id_type,
    String(b.id_number || current.id_number).replace(/\D/g, ""),
    String(b.activity_code || current.activity_code).replace(/\D/g, ""),
    b.email || current.email,
    b.phone_country || current.phone_country,
    String(b.phone_number || current.phone_number).replace(/\D/g, ""),
    b.province || current.province,
    b.canton || current.canton,
    b.district || current.district,
    b.address_detail || current.address_detail,
    String(b.branch || current.branch).padStart(3, "0").slice(-3),
    String(b.terminal || current.terminal).padStart(5, "0").slice(-5),
    b.atv_username ?? current.atv_username,
    nextAtvPass
  );

  res.json(sanitizeEmitter(getEmitterConfig()));
});

app.post("/api/emitter/p12", upload.single("p12"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Debes adjuntar el archivo .p12" });
    const pin = req.body.pin || "";
    const buf = fs.readFileSync(req.file.path);
    const info = parseP12(buf, pin);

    const destPath = path.join(CERTS_DIR, "emitter_key.p12");
    fs.renameSync(req.file.path, destPath);

    db.prepare(
      "UPDATE emitter_config SET p12_path = ?, p12_pin = ?, p12_subject = ?, p12_valid_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1"
    ).run(destPath, pin, info.subjectCN, info.validTo);

    res.json({
      ok: true,
      subject: info.subjectCN,
      validTo: info.validTo,
      emitter: sanitizeEmitter(getEmitterConfig()),
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: `No se pudo validar el .p12: ${err.message}` });
  }
});

app.post("/api/emitter/test-auth", async (_req, res) => {
  try {
    const emitter = getEmitterConfig();
    const token = await getAccessToken(emitter.environment, emitter.atv_username, emitter.atv_password);
    res.json({
      ok: true,
      environment: emitter.environment,
      tokenPreview: `${token.slice(0, 24)}...`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// === CLIENTES ===
app.get("/api/clients", (_req, res) => {
  res.json(db.prepare("SELECT * FROM clients ORDER BY id DESC").all());
});

app.post("/api/clients", (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.id_number) {
    return res.status(400).json({ error: "Nombre y número de identificación son requeridos." });
  }
  const info = db
    .prepare(
      `INSERT INTO clients (name, commercial_name, id_type, id_number, email, phone, address_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.name.trim(),
      b.commercial_name || "",
      b.id_type || "01",
      String(b.id_number).replace(/\D/g, ""),
      b.email || "",
      b.phone || "",
      b.address_detail || "Costa Rica"
    );
  res.status(201).json(db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid));
});

app.delete("/api/clients/:id", (req, res) => {
  db.prepare("DELETE FROM clients WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// === PRODUCTOS CABYS ===
app.get("/api/products", (_req, res) => {
  res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all());
});

app.post("/api/products", (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.cabys) {
    return res.status(400).json({ error: "Nombre y código CABYS (13 dígitos) son requeridos." });
  }
  const taxRate = Number(b.tax_rate ?? 13);
  const taxRateCode = TAX_RATE_CODE_MAP[taxRate] || "08";
  const info = db
    .prepare(
      `INSERT INTO products (code, cabys, name, unit, unit_price, currency, tax_rate, tax_code, tax_rate_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, '01', ?)`
    )
    .run(
      b.code || "",
      String(b.cabys).replace(/\D/g, "").padEnd(13, "0").slice(0, 13),
      b.name.trim(),
      b.unit || "Sp",
      Number(b.unit_price || 0),
      b.currency || "CRC",
      taxRate,
      taxRateCode
    );
  res.status(201).json(db.prepare("SELECT * FROM products WHERE id = ?").get(info.lastInsertRowid));
});

app.delete("/api/products/:id", (req, res) => {
  db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// === COMPROBANTES ===
app.get("/api/invoices", (_req, res) => {
  const rows = db.prepare("SELECT * FROM invoices ORDER BY id DESC LIMIT 200").all();
  res.json(rows);
});

app.get("/api/invoices/:id", (req, res) => {
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Comprobante no encontrado" });
  const lines = db.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_number ASC").all(invoice.id);
  res.json({ ...invoice, lines });
});

app.post("/api/invoices", async (req, res) => {
  try {
    const b = req.body || {};
    const docType = b.doc_type || "01";
    const rawLines = Array.isArray(b.lines) ? b.lines : [];
    if (rawLines.length === 0) {
      return res.status(400).json({ error: "Debes agregar al menos una línea de detalle." });
    }

    const emitter = getEmitterConfig();
    const seq = getNextSequenceAndIncrement(docType);
    const consecutive = buildConsecutive(emitter.branch, emitter.terminal, docType, seq);
    const { clave, issueDate } = buildClave({
      idNumber: emitter.id_number,
      consecutive,
      situation: b.situation || "1",
    });

    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;
    let total = 0;

    const computedLines = rawLines.map((l, idx) => {
      const qty = Number(l.quantity || 1);
      const unitPrice = Number(l.unit_price || 0);
      const lineGross = qty * unitPrice;
      const discount = Number(l.discount || 0);
      const lineSub = lineGross - discount;
      const taxRate = Number(l.tax_rate ?? 13);
      const taxRateCode = l.tax_rate_code || TAX_RATE_CODE_MAP[taxRate] || "08";
      const taxAmount = lineSub * (taxRate / 100);
      const lineTotal = lineSub + taxAmount;

      subtotal += lineSub;
      discountTotal += discount;
      taxTotal += taxAmount;
      total += lineTotal;

      return {
        line_number: idx + 1,
        product_id: l.product_id || null,
        cabys: String(l.cabys || "8314100000000").replace(/\D/g, "").padEnd(13, "0").slice(0, 13),
        description: l.description || "Servicio",
        unit: l.unit || "Sp",
        quantity: qty,
        unit_price: unitPrice,
        discount,
        subtotal: lineSub,
        tax_rate: taxRate,
        tax_rate_code: taxRateCode,
        tax_amount: taxAmount,
        line_total: lineTotal,
      };
    });

    const invoiceDraft = {
      doc_type: docType,
      clave,
      consecutive,
      environment: emitter.environment,
      issue_date: issueDate,
      client_id: b.client_id || null,
      client_name: b.client_name || "Cliente Contado",
      client_id_type: b.client_id_type || "01",
      client_id_number: String(b.client_id_number || "").replace(/\D/g, ""),
      client_email: b.client_email || "",
      currency: b.currency || "CRC",
      exchange_rate: Number(b.exchange_rate || 1),
      sale_condition: b.sale_condition || "01",
      credit_term_days: Number(b.credit_term_days || 0),
      payment_method: b.payment_method || "01",
      subtotal,
      discount_total: discountTotal,
      tax_total: taxTotal,
      total,
      ref_doc_type: b.ref_doc_type || "",
      ref_clave: b.ref_clave || "",
      ref_date: b.ref_date || "",
      ref_code: b.ref_code || "",
      ref_reason: b.ref_reason || "",
      notes: b.notes || "",
    };

    const xmlUnsigned = buildComprobanteXml({
      emitter,
      invoice: invoiceDraft,
      lines: computedLines,
    });

    let xmlSigned = "";
    let status = "borrador";
    let haciendaMessage = "XML v4.4 generado (pendiente de firma/envío).";

    const hasP12 = Boolean(emitter.p12_path && fs.existsSync(emitter.p12_path));
    if (hasP12) {
      const signed = signXmlXadesEpes(xmlUnsigned, emitter.p12_path, emitter.p12_pin);
      xmlSigned = signed.signedXml;
      status = "firmado";
      haciendaMessage = "Firmado con XAdES-EPES.";
    }

    const insertInv = db
      .prepare(
        `INSERT INTO invoices (
          doc_type, clave, consecutive, environment, issue_date,
          client_id, client_name, client_id_type, client_id_number, client_email,
          currency, exchange_rate, sale_condition, credit_term_days, payment_method,
          subtotal, discount_total, tax_total, total,
          ref_doc_type, ref_clave, ref_date, ref_code, ref_reason, notes,
          xml_unsigned, xml_signed, status, hacienda_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        invoiceDraft.doc_type,
        invoiceDraft.clave,
        invoiceDraft.consecutive,
        invoiceDraft.environment,
        invoiceDraft.issue_date,
        invoiceDraft.client_id,
        invoiceDraft.client_name,
        invoiceDraft.client_id_type,
        invoiceDraft.client_id_number,
        invoiceDraft.client_email,
        invoiceDraft.currency,
        invoiceDraft.exchange_rate,
        invoiceDraft.sale_condition,
        invoiceDraft.credit_term_days,
        invoiceDraft.payment_method,
        invoiceDraft.subtotal,
        invoiceDraft.discount_total,
        invoiceDraft.tax_total,
        invoiceDraft.total,
        invoiceDraft.ref_doc_type,
        invoiceDraft.ref_clave,
        invoiceDraft.ref_date,
        invoiceDraft.ref_code,
        invoiceDraft.ref_reason,
        invoiceDraft.notes,
        xmlUnsigned,
        xmlSigned,
        status,
        haciendaMessage
      );

    const invoiceId = insertInv.lastInsertRowid;
    const insLine = db.prepare(
      `INSERT INTO invoice_lines (
        invoice_id, line_number, product_id, cabys, description, unit,
        quantity, unit_price, discount, subtotal, tax_rate, tax_rate_code, tax_amount, line_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of computedLines) {
      insLine.run(
        invoiceId,
        l.line_number,
        l.product_id,
        l.cabys,
        l.description,
        l.unit,
        l.quantity,
        l.unit_price,
        l.discount,
        l.subtotal,
        l.tax_rate,
        l.tax_rate_code,
        l.tax_amount,
        l.line_total
      );
    }

    // Si el usuario pidió enviar de inmediato y hay credenciales ATV + .p12
    if (b.send_to_hacienda && xmlSigned && emitter.atv_username && emitter.atv_password) {
      try {
        const sent = await sendComprobante({ emitter, invoice: invoiceDraft, signedXml: xmlSigned });
        db.prepare("UPDATE invoices SET status = ?, hacienda_message = ? WHERE id = ?").run(
          sent.status,
          sent.message,
          invoiceId
        );
      } catch (err) {
        db.prepare("UPDATE invoices SET status = 'error', hacienda_message = ? WHERE id = ?").run(
          err.message,
          invoiceId
        );
      }
    }

    const created = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/invoices/:id/send", async (req, res) => {
  try {
    const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Comprobante no encontrado" });
    const emitter = getEmitterConfig();

    let signedXml = invoice.xml_signed;
    if (!signedXml) {
      const signed = signXmlXadesEpes(invoice.xml_unsigned, emitter.p12_path, emitter.p12_pin);
      signedXml = signed.signedXml;
      db.prepare("UPDATE invoices SET xml_signed = ?, status = 'firmado' WHERE id = ?").run(
        signedXml,
        invoice.id
      );
    }

    const sent = await sendComprobante({ emitter, invoice, signedXml });
    db.prepare("UPDATE invoices SET status = ?, hacienda_message = ? WHERE id = ?").run(
      sent.status,
      sent.message,
      invoice.id
    );
    res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoice.id));
  } catch (err) {
    db.prepare("UPDATE invoices SET status = 'error', hacienda_message = ? WHERE id = ?").run(
      err.message,
      req.params.id
    );
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/invoices/:id/check", async (req, res) => {
  try {
    const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Comprobante no encontrado" });
    const emitter = getEmitterConfig();

    const result = await queryComprobanteStatus({ emitter, clave: invoice.clave });
    const msg = `Hacienda: ${result.indEstado}${result.fecha ? ` (${result.fecha})` : ""}`;
    db.prepare(
      "UPDATE invoices SET status = ?, hacienda_message = ?, hacienda_response_xml = ? WHERE id = ?"
    ).run(result.indEstado, msg, result.responseXml, invoice.id);

    res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoice.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/invoices/:id/xml", (req, res) => {
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!invoice) return res.status(404).send("Not found");
  const xml = invoice.xml_signed || invoice.xml_unsigned;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${invoice.clave}.xml"`);
  res.send(xml);
});

app.get("/api/invoices/:id/pdf", async (req, res) => {
  try {
    const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
    if (!invoice) return res.status(404).send("Not found");
    const lines = db
      .prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_number ASC")
      .all(invoice.id);
    const emitter = getEmitterConfig();
    const pdfBuf = await generateInvoicePdfBuffer({ emitter, invoice, lines });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.consecutive}.pdf"`);
    res.send(pdfBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`AuraFlow Facturador CR v4.4 listening on http://127.0.0.1:${PORT}`);
});
