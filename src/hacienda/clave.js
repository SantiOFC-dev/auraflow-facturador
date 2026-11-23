const crypto = require("crypto");

/**
 * Devuelve la fecha/hora actual de Costa Rica (UTC-6) en formato ISO-8601 requerido por Hacienda.
 * Ej: 2026-11-21T13:11:00-06:00
 */
function getCostaRicaIsoDate(date = new Date()) {
  const crMs = date.getTime() - 6 * 60 * 60 * 1000;
  const cr = new Date(crMs);
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = cr.getUTCFullYear();
  const mm = pad(cr.getUTCMonth() + 1);
  const dd = pad(cr.getUTCDate());
  const hh = pad(cr.getUTCHours());
  const mi = pad(cr.getUTCMinutes());
  const ss = pad(cr.getUTCSeconds());
  return {
    iso: `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}-06:00`,
    dd,
    mm,
    yy: String(yyyy).slice(-2),
  };
}

/**
 * Genera el Consecutivo de 20 dígitos:
 * - Sucursal (3)
 * - Terminal / Punto de venta (5)
 * - Tipo de comprobante (2): 01 FE, 02 ND, 03 NC, 04 TE
 * - Consecutivo (10)
 */
function buildConsecutive(branch, terminal, docType, sequenceNumber) {
  const suc = String(branch || "001").replace(/\D/g, "").padStart(3, "0").slice(-3);
  const term = String(terminal || "00001").replace(/\D/g, "").padStart(5, "0").slice(-5);
  const tipo = String(docType || "01").replace(/\D/g, "").padStart(2, "0").slice(-2);
  const seq = String(sequenceNumber).replace(/\D/g, "").padStart(10, "0").slice(-10);
  return `${suc}${term}${tipo}${seq}`;
}

/**
 * Genera la Clave Numérica oficial de 50 dígitos de Hacienda Costa Rica:
 * 506 (3) + DD (2) + MM (2) + AA (2) + Cédula Emisor (12) + Consecutivo (20) + Situación (1) + Seguridad (8)
 */
function buildClave({ idNumber, consecutive, situation = "1", date = new Date() }) {
  const crDate = getCostaRicaIsoDate(date);
  const cedula12 = String(idNumber || "").replace(/\D/g, "").padStart(12, "0").slice(-12);
  const consec20 = String(consecutive).padStart(20, "0").slice(-20);
  const sit = String(situation || "1").slice(0, 1);
  const security8 = String(crypto.randomInt(10000000, 99999999));
  const clave = `506${crDate.dd}${crDate.mm}${crDate.yy}${cedula12}${consec20}${sit}${security8}`;
  if (clave.length !== 50) {
    throw new Error(`La clave generada debe medir 50 dígitos, midió ${clave.length}`);
  }
  return { clave, issueDate: crDate.iso };
}

module.exports = {
  getCostaRicaIsoDate,
  buildConsecutive,
  buildClave,
};
