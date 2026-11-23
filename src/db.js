const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
const CERTS_DIR = path.join(DATA_DIR, "certs");
fs.mkdirSync(CERTS_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "facturador.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS emitter_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    environment TEXT NOT NULL DEFAULT 'sandbox', -- 'sandbox' | 'prod'
    name TEXT NOT NULL DEFAULT 'AuraFlow Tech S.R.L.',
    commercial_name TEXT DEFAULT 'AuraFlow Tech',
    id_type TEXT NOT NULL DEFAULT '02', -- 01 Fisica, 02 Juridica, 03 DIMEX, 04 NITE
    id_number TEXT NOT NULL DEFAULT '3101000000',
    activity_code TEXT NOT NULL DEFAULT '620100', -- 6 digitos CIIU4 / Hacienda
    email TEXT NOT NULL DEFAULT 'facturacion@auraflowtech.lat',
    phone_country TEXT DEFAULT '506',
    phone_number TEXT DEFAULT '22000000',
    province TEXT NOT NULL DEFAULT '1',
    canton TEXT NOT NULL DEFAULT '01',
    district TEXT NOT NULL DEFAULT '01',
    barrio TEXT DEFAULT '01',
    address_detail TEXT NOT NULL DEFAULT 'San José, Costa Rica',
    branch TEXT NOT NULL DEFAULT '001',
    terminal TEXT NOT NULL DEFAULT '00001',
    seq_fe INTEGER NOT NULL DEFAULT 1,
    seq_nd INTEGER NOT NULL DEFAULT 1,
    seq_nc INTEGER NOT NULL DEFAULT 1,
    seq_te INTEGER NOT NULL DEFAULT 1,
    atv_username TEXT DEFAULT '',
    atv_password TEXT DEFAULT '',
    p12_path TEXT DEFAULT '',
    p12_pin TEXT DEFAULT '',
    p12_subject TEXT DEFAULT '',
    p12_valid_to TEXT DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    commercial_name TEXT DEFAULT '',
    id_type TEXT NOT NULL DEFAULT '01',
    id_number TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    province TEXT DEFAULT '1',
    canton TEXT DEFAULT '01',
    district TEXT DEFAULT '01',
    address_detail TEXT DEFAULT 'Costa Rica',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT DEFAULT '',
    cabys TEXT NOT NULL,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'Sp', -- Sp (Servicios Profesionales), Unid, Os, etc.
    unit_price REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CRC',
    tax_rate REAL NOT NULL DEFAULT 13, -- 13, 4, 2, 1, 0
    tax_code TEXT NOT NULL DEFAULT '01', -- 01 IVA
    tax_rate_code TEXT NOT NULL DEFAULT '08', -- 08 = 13%, 04 = 4%, 03 = 2%, 02 = 1%, 01 = 0%
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_type TEXT NOT NULL, -- '01' FE, '02' ND, '03' NC, '04' TE
    clave TEXT NOT NULL UNIQUE,
    consecutive TEXT NOT NULL,
    environment TEXT NOT NULL,
    issue_date TEXT NOT NULL,
    client_id INTEGER,
    client_name TEXT NOT NULL,
    client_id_type TEXT DEFAULT '01',
    client_id_number TEXT DEFAULT '',
    client_email TEXT DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'CRC',
    exchange_rate REAL NOT NULL DEFAULT 1,
    sale_condition TEXT NOT NULL DEFAULT '01', -- 01 Contado, 02 Credito
    credit_term_days INTEGER DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT '01', -- 01 Efectivo, 02 Tarjeta, 03 Cheque, 04 Transferencia
    subtotal REAL NOT NULL DEFAULT 0,
    discount_total REAL NOT NULL DEFAULT 0,
    tax_total REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    ref_doc_type TEXT DEFAULT '',
    ref_clave TEXT DEFAULT '',
    ref_date TEXT DEFAULT '',
    ref_code TEXT DEFAULT '',
    ref_reason TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    xml_unsigned TEXT NOT NULL,
    xml_signed TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'borrador', -- borrador, firmado, enviado, aceptado, rechazado, error
    hacienda_message TEXT DEFAULT '',
    hacienda_response_xml TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoice_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    product_id INTEGER,
    cabys TEXT NOT NULL,
    description TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'Sp',
    quantity REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 13,
    tax_rate_code TEXT NOT NULL DEFAULT '08',
    tax_amount REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL DEFAULT 0
  );
`);

// Seed emitter_config if empty
const emitterCount = db.prepare("SELECT COUNT(*) as c FROM emitter_config").get().c;
if (emitterCount === 0) {
  db.prepare("INSERT INTO emitter_config (id) VALUES (1)").run();
}

// Seed sample client & products if empty
const clientCount = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;
if (clientCount === 0) {
  db.prepare(`
    INSERT INTO clients (name, commercial_name, id_type, id_number, email, phone, address_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "Cliente Contado Demo",
    "Demo CR",
    "01",
    "115000500",
    "cliente@ejemplo.cr",
    "88000000",
    "San José, Central, Carmen"
  );
}

const prodCount = db.prepare("SELECT COUNT(*) as c FROM products").get().c;
if (prodCount === 0) {
  const ins = db.prepare(`
    INSERT INTO products (code, cabys, name, unit, unit_price, currency, tax_rate, tax_code, tax_rate_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  ins.run("SRV-001", "8314100000000", "Desarrollo de Software y Sistemas Web", "Sp", 50000, "CRC", 13, "01", "08");
  ins.run("SRV-002", "8313200000000", "Soporte Técnico y Mantenimiento de Servidores", "Sp", 25000, "CRC", 13, "01", "08");
  ins.run("PRD-001", "4523000000100", "Equipo de Cómputo / Router Empresarial", "Unid", 45000, "CRC", 13, "01", "08");
}

function getEmitterConfig() {
  return db.prepare("SELECT * FROM emitter_config WHERE id = 1").get();
}

function getNextSequenceAndIncrement(docType) {
  const colMap = {
    "01": "seq_fe",
    "02": "seq_nd",
    "03": "seq_nc",
    "04": "seq_te",
  };
  const col = colMap[docType];
  if (!col) throw new Error(`Tipo de documento inválido: ${docType}`);
  const cfg = getEmitterConfig();
  const current = cfg[col];
  db.prepare(`UPDATE emitter_config SET ${col} = ${col} + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run();
  return current;
}

module.exports = {
  db,
  DATA_DIR,
  CERTS_DIR,
  getEmitterConfig,
  getNextSequenceAndIncrement,
};
