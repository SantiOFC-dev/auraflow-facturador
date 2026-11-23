const DOC_CONFIG = {
  "01": {
    rootTag: "FacturaElectronica",
    namespace: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica",
  },
  "02": {
    rootTag: "NotaDebitoElectronica",
    namespace: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaDebitoElectronica",
  },
  "03": {
    rootTag: "NotaCreditoElectronica",
    namespace: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaCreditoElectronica",
  },
  "04": {
    rootTag: "TiqueteElectronico",
    namespace: "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico",
  },
};

const TAX_RATE_CODE_MAP = {
  0: "01",
  1: "02",
  2: "03",
  4: "04",
  8: "07",
  13: "08",
};

function escXml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmt(num, decimals = 5) {
  return Number(num || 0).toFixed(decimals);
}

/**
 * Construye el XML oficial v4.4 de Hacienda Costa Rica (sin firmar)
 */
function buildComprobanteXml({ emitter, invoice, lines }) {
  const cfg = DOC_CONFIG[invoice.doc_type];
  if (!cfg) throw new Error(`Tipo de comprobante no soportado: ${invoice.doc_type}`);

  const isServiceUnit = (unit) => ["Sp", "Spe", "St", "Os", "Al", "Alc", "Cm", "I", "A"].includes(unit);

  let totalServGravados = 0;
  let totalServExentos = 0;
  let totalMercGravadas = 0;
  let totalMercExentas = 0;
  let totalDescuentos = 0;
  let totalImpuesto = 0;

  const linesXml = lines
    .map((line, idx) => {
      const qty = Number(line.quantity || 1);
      const unitPrice = Number(line.unit_price || 0);
      const montoTotal = qty * unitPrice;
      const discount = Number(line.discount || 0);
      const subTotal = montoTotal - discount;
      const taxRate = Number(line.tax_rate ?? 13);
      const taxRateCode = line.tax_rate_code || TAX_RATE_CODE_MAP[taxRate] || "08";
      const taxAmount = subTotal * (taxRate / 100);
      const lineTotal = subTotal + taxAmount;

      const esServicio = isServiceUnit(line.unit || "Sp");
      if (taxRate > 0) {
        if (esServicio) totalServGravados += montoTotal;
        else totalMercGravadas += montoTotal;
      } else {
        if (esServicio) totalServExentos += montoTotal;
        else totalMercExentas += montoTotal;
      }
      totalDescuentos += discount;
      totalImpuesto += taxAmount;

      const discountXml =
        discount > 0
          ? `
      <Descuento>
        <MontoDescuento>${fmt(discount)}</MontoDescuento>
        <CodigoDescuento>07</CodigoDescuento>
        <NaturalezaDescuento>Descuento comercial</NaturalezaDescuento>
      </Descuento>`
          : "";

      return `    <LineaDetalle>
      <NumeroLinea>${idx + 1}</NumeroLinea>
      <CodigoCABYS>${escXml(String(line.cabys || "8314100000000").padEnd(13, "0").slice(0, 13))}</CodigoCABYS>
      <Cantidad>${fmt(qty, 3)}</Cantidad>
      <UnidadMedida>${escXml(line.unit || "Sp")}</UnidadMedida>
      <Detalle>${escXml(String(line.description || "Servicio").slice(0, 200))}</Detalle>
      <PrecioUnitario>${fmt(unitPrice)}</PrecioUnitario>
      <MontoTotal>${fmt(montoTotal)}</MontoTotal>${discountXml}
      <SubTotal>${fmt(subTotal)}</SubTotal>
      <BaseImponible>${fmt(subTotal)}</BaseImponible>
      <Impuesto>
        <Codigo>01</Codigo>
        <CodigoTarifaIVA>${escXml(taxRateCode)}</CodigoTarifaIVA>
        <Tarifa>${fmt(taxRate, 2)}</Tarifa>
        <Monto>${fmt(taxAmount)}</Monto>
      </Impuesto>
      <ImpuestoAsumidoEmisorFabrica>0.00000</ImpuestoAsumidoEmisorFabrica>
      <ImpuestoNeto>${fmt(taxAmount)}</ImpuestoNeto>
      <MontoTotalLinea>${fmt(lineTotal)}</MontoTotalLinea>
    </LineaDetalle>`;
    })
    .join("\n");

  const totalGravado = totalServGravados + totalMercGravadas;
  const totalExento = totalServExentos + totalMercExentas;
  const totalVenta = totalGravado + totalExento;
  const totalVentaNeta = totalVenta - totalDescuentos;
  const totalComprobante = totalVentaNeta + totalImpuesto;

  // Receptor (obligatorio en FE/NC/ND si hay identificación, opcional en Tiquete)
  let receptorXml = "";
  if (invoice.client_name && (invoice.doc_type !== "04" || invoice.client_id_number)) {
    const idBlock = invoice.client_id_number
      ? `
    <Identificacion>
      <Tipo>${escXml(invoice.client_id_type || "01")}</Tipo>
      <Numero>${escXml(String(invoice.client_id_number).replace(/\D/g, ""))}</Numero>
    </Identificacion>`
      : "";
    const emailBlock = invoice.client_email
      ? `\n    <CorreoElectronico>${escXml(invoice.client_email)}</CorreoElectronico>`
      : "";
    receptorXml = `
  <Receptor>
    <Nombre>${escXml(String(invoice.client_name).slice(0, 100))}</Nombre>${idBlock}${emailBlock}
  </Receptor>`;
  }

  // Información de Referencia (para Nota de Crédito / Nota de Débito)
  let refXml = "";
  if ((invoice.doc_type === "02" || invoice.doc_type === "03") && invoice.ref_clave) {
    refXml = `
  <InformacionReferencia>
    <TipoDocIR>${escXml(invoice.ref_doc_type || "01")}</TipoDocIR>
    <Numero>${escXml(invoice.ref_clave)}</Numero>
    <FechaEmisionIR>${escXml(invoice.ref_date || invoice.issue_date)}</FechaEmisionIR>
    <Codigo>${escXml(invoice.ref_code || "01")}</Codigo>
    <Razon>${escXml((invoice.ref_reason || "Anulación o corrección de documento").slice(0, 180))}</Razon>
  </InformacionReferencia>`;
  }

  const plazoXml =
    invoice.sale_condition === "02"
      ? `\n  <PlazoCredito>${Number(invoice.credit_term_days || 30)}</PlazoCredito>`
      : "";

  const cedulaEmisor = String(emitter.id_number || "").replace(/\D/g, "");

  return `<?xml version="1.0" encoding="utf-8"?>
<${cfg.rootTag} xmlns="${cfg.namespace}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Clave>${escXml(invoice.clave)}</Clave>
  <ProveedorSistemas>${escXml(cedulaEmisor)}</ProveedorSistemas>
  <CodigoActividadEmisor>${escXml(String(emitter.activity_code || "620100").padStart(6, "0").slice(0, 6))}</CodigoActividadEmisor>
  <NumeroConsecutivo>${escXml(invoice.consecutive)}</NumeroConsecutivo>
  <FechaEmision>${escXml(invoice.issue_date)}</FechaEmision>
  <Emisor>
    <Nombre>${escXml(emitter.name)}</Nombre>
    <Identificacion>
      <Tipo>${escXml(emitter.id_type || "02")}</Tipo>
      <Numero>${escXml(cedulaEmisor)}</Numero>
    </Identificacion>
    ${emitter.commercial_name ? `<NombreComercial>${escXml(emitter.commercial_name)}</NombreComercial>` : ""}
    <Ubicacion>
      <Provincia>${escXml(emitter.province || "1")}</Provincia>
      <Canton>${escXml(String(emitter.canton || "01").padStart(2, "0"))}</Canton>
      <Distrito>${escXml(String(emitter.district || "01").padStart(2, "0"))}</Distrito>
      <OtrasSenas>${escXml(emitter.address_detail || "San José, Costa Rica")}</OtrasSenas>
    </Ubicacion>
    <Telefono>
      <CodigoPais>${escXml(emitter.phone_country || "506")}</CodigoPais>
      <NumTelefono>${escXml(String(emitter.phone_number || "22000000").replace(/\D/g, ""))}</NumTelefono>
    </Telefono>
    <CorreoElectronico>${escXml(emitter.email)}</CorreoElectronico>
  </Emisor>${receptorXml}
  <CondicionVenta>${escXml(invoice.sale_condition || "01")}</CondicionVenta>${plazoXml}
  <MedioPago>${escXml(invoice.payment_method || "01")}</MedioPago>
  <DetalleServicio>
${linesXml}
  </DetalleServicio>
  <ResumenFactura>
    <CodigoTipoMoneda>
      <CodigoMoneda>${escXml(invoice.currency || "CRC")}</CodigoMoneda>
      <TipoCambio>${fmt(invoice.exchange_rate || 1)}</TipoCambio>
    </CodigoTipoMoneda>
    <TotalServGravados>${fmt(totalServGravados)}</TotalServGravados>
    <TotalServExentos>${fmt(totalServExentos)}</TotalServExentos>
    <TotalServExonerado>0.00000</TotalServExonerado>
    <TotalServNoSujeto>0.00000</TotalServNoSujeto>
    <TotalMercanciasGravadas>${fmt(totalMercGravadas)}</TotalMercanciasGravadas>
    <TotalMercanciasExentas>${fmt(totalMercExentas)}</TotalMercanciasExentas>
    <TotalMercExonerada>0.00000</TotalMercExonerada>
    <TotalMercNoSujeta>0.00000</TotalMercNoSujeta>
    <TotalGravado>${fmt(totalGravado)}</TotalGravado>
    <TotalExento>${fmt(totalExento)}</TotalExento>
    <TotalExonerado>0.00000</TotalExonerado>
    <TotalNoSujeto>0.00000</TotalNoSujeto>
    <TotalVenta>${fmt(totalVenta)}</TotalVenta>
    <TotalDescuentos>${fmt(totalDescuentos)}</TotalDescuentos>
    <TotalVentaNeta>${fmt(totalVentaNeta)}</TotalVentaNeta>
    <TotalImpuesto>${fmt(totalImpuesto)}</TotalImpuesto>
    <TotalOtrosCargos>0.00000</TotalOtrosCargos>
    <TotalComprobante>${fmt(totalComprobante)}</TotalComprobante>
  </ResumenFactura>${refXml}
</${cfg.rootTag}>`;
}

module.exports = {
  DOC_CONFIG,
  TAX_RATE_CODE_MAP,
  buildComprobanteXml,
};
