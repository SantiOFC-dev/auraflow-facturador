let clientsCache = [];
let productsCache = [];
let emitLines = [];

const DOC_LABELS = { "01": "FE", "02": "ND", "03": "NC", "04": "TE" };

function showToast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${isError ? "error" : ""}`;
  setTimeout(() => el.classList.add("hidden"), 4500);
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error HTTP ${res.status}`);
  return data;
}

function money(val, cur = "CRC") {
  const sym = cur === "USD" ? "$" : "₡";
  return `${sym}${Number(val || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById(`view-${view}`).classList.add("active");
  document.querySelector(`.nav-btn[data-view="${view}"]`)?.classList.add("active");

  const titles = {
    dashboard: "Resumen",
    emit: "Emitir Comprobante Electrónico",
    invoices: "Historial de Comprobantes",
    clients: "Clientes",
    products: "Productos y Servicios CABYS",
    config: "Configuración Emisor, ATV y .p12",
  };
  document.getElementById("viewTitle").textContent = titles[view] || view;

  if (view === "dashboard") loadDashboard();
  if (view === "invoices") loadInvoices();
  if (view === "clients") loadClients();
  if (view === "products") loadProducts();
  if (view === "config") loadEmitterConfig();
  if (view === "emit") {
    loadClients();
    loadProducts();
  }
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

async function loadDashboard() {
  const d = await api("/api/dashboard");
  const envPill = document.getElementById("sidebarEnv");
  envPill.className = `env-pill ${d.environment === "prod" ? "prod" : ""}`;
  document.getElementById("sidebarEnvText").textContent =
    d.environment === "prod" ? "PRODUCCIÓN" : "SANDBOX (PRUEBAS)";

  document.getElementById("kpiBilled").textContent = money(d.stats.net_billed);
  document.getElementById("kpiTax").textContent = money(d.stats.net_tax);
  document.getElementById("kpiAccepted").textContent = d.stats.accepted_count || 0;
  document.getElementById("kpiPending").textContent =
    (d.stats.pending_count || 0) + (d.stats.rejected_count || 0);

  document.getElementById("readinessBanner").innerHTML = `
    <strong>Emisor:</strong> ${d.emitterName} &nbsp;|&nbsp;
    <strong>Ambiente:</strong> ${d.environment === "prod" ? "Producción" : "Sandbox (Pruebas)"} &nbsp;|&nbsp;
    <strong>Llave .p12:</strong> ${d.p12Ready ? "✅ Cargada" : "⚠️ Pendiente"} &nbsp;|&nbsp;
    <strong>Credenciales ATV:</strong> ${d.atvReady ? "✅ Configuradas" : "⚠️ Pendientes"}
  `;

  document.getElementById("recentTableBody").innerHTML =
    d.recent.length === 0
      ? `<tr><td colspan="6" class="muted">Aún no hay comprobantes emitidos.</td></tr>`
      : d.recent
          .map(
            (inv) => `
      <tr>
        <td><strong>${DOC_LABELS[inv.doc_type] || inv.doc_type}</strong></td>
        <td class="mono">${inv.consecutive}</td>
        <td>${inv.client_name}</td>
        <td>${money(inv.total, inv.currency)}</td>
        <td><span class="badge badge-${inv.status}">${inv.status}</span></td>
        <td>
          <a class="btn btn-sm" href="/api/invoices/${inv.id}/pdf" target="_blank">PDF</a>
          <a class="btn btn-sm" href="/api/invoices/${inv.id}/xml">XML</a>
        </td>
      </tr>`
          )
          .join("");
}

async function loadClients() {
  clientsCache = await api("/api/clients");
  const sel = document.getElementById("clientSelect");
  sel.innerHTML = `<option value="">-- Ingreso manual / Contado --</option>` +
    clientsCache.map((c) => `<option value="${c.id}">${c.name} (${c.id_number})</option>`).join("");

  document.getElementById("clientsTableBody").innerHTML = clientsCache
    .map(
      (c) => `
    <tr>
      <td>${c.name}</td>
      <td class="mono">${c.id_number}</td>
      <td>${c.email || "-"}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteClient(${c.id})">Eliminar</button></td>
    </tr>`
    )
    .join("");
}

function fillClientFromSelect() {
  const id = Number(document.getElementById("clientSelect").value);
  const c = clientsCache.find((x) => x.id === id);
  if (!c) return;
  document.getElementById("clientName").value = c.name;
  document.getElementById("clientIdType").value = c.id_type;
  document.getElementById("clientIdNumber").value = c.id_number;
  document.getElementById("clientEmail").value = c.email || "";
}

async function deleteClient(id) {
  await api(`/api/clients/${id}`, { method: "DELETE" });
  showToast("Cliente eliminado");
  loadClients();
}

document.getElementById("clientForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("cName").value,
        id_type: document.getElementById("cIdType").value,
        id_number: document.getElementById("cIdNumber").value,
        email: document.getElementById("cEmail").value,
        phone: document.getElementById("cPhone").value,
        address_detail: document.getElementById("cAddress").value,
      }),
    });
    e.target.reset();
    showToast("Cliente guardado");
    loadClients();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function loadProducts() {
  productsCache = await api("/api/products");
  const sel = document.getElementById("quickProductSelect");
  sel.innerHTML = `<option value="">+ Agregar desde catálogo CABYS...</option>` +
    productsCache.map((p) => `<option value="${p.id}">${p.name} (${money(p.unit_price)})</option>`).join("");

  document.getElementById("productsTableBody").innerHTML = productsCache
    .map(
      (p) => `
    <tr>
      <td class="mono">${p.cabys}</td>
      <td>${p.name}</td>
      <td>${money(p.unit_price, p.currency)}</td>
      <td>${p.tax_rate}%</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteProduct(${p.id})">Eliminar</button></td>
    </tr>`
    )
    .join("");
}

async function deleteProduct(id) {
  await api(`/api/products/${id}`, { method: "DELETE" });
  showToast("Producto eliminado");
  loadProducts();
}

document.getElementById("productForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: document.getElementById("pCode").value,
        cabys: document.getElementById("pCabys").value,
        name: document.getElementById("pName").value,
        unit: document.getElementById("pUnit").value,
        unit_price: Number(document.getElementById("pPrice").value),
        tax_rate: Number(document.getElementById("pTax").value),
      }),
    });
    e.target.reset();
    showToast("Producto CABYS guardado");
    loadProducts();
  } catch (err) {
    showToast(err.message, true);
  }
});

// === EMISIÓN ===
function toggleRefFields() {
  const t = document.getElementById("docType").value;
  document.getElementById("refFields").classList.toggle("hidden", t !== "02" && t !== "03");
}

function toggleExchangeRate() {
  const c = document.getElementById("currency").value;
  document.getElementById("exchangeRateWrap").style.display = c === "USD" ? "flex" : "none";
}

function addProductLine() {
  const id = Number(document.getElementById("quickProductSelect").value);
  const p = productsCache.find((x) => x.id === id);
  if (!p) return addEmptyLine();
  emitLines.push({
    product_id: p.id,
    cabys: p.cabys,
    description: p.name,
    unit: p.unit,
    quantity: 1,
    unit_price: p.unit_price,
    discount: 0,
    tax_rate: p.tax_rate,
  });
  renderLines();
}

function addEmptyLine() {
  emitLines.push({
    cabys: "8314100000000",
    description: "Servicios Profesionales",
    unit: "Sp",
    quantity: 1,
    unit_price: 10000,
    discount: 0,
    tax_rate: 13,
  });
  renderLines();
}

function removeLine(idx) {
  emitLines.splice(idx, 1);
  renderLines();
}

function updateLine(idx, field, val) {
  emitLines[idx][field] = ["quantity", "unit_price", "discount", "tax_rate"].includes(field)
    ? Number(val || 0)
    : val;
  renderLines();
}

function renderLines() {
  const cur = document.getElementById("currency").value;
  let sub = 0, disc = 0, tax = 0, tot = 0;

  document.getElementById("linesBody").innerHTML = emitLines
    .map((l, idx) => {
      const lineSub = l.quantity * l.unit_price - l.discount;
      const lineTax = lineSub * (l.tax_rate / 100);
      const lineTot = lineSub + lineTax;
      sub += lineSub;
      disc += l.discount;
      tax += lineTax;
      tot += lineTot;
      return `
      <tr>
        <td><input value="${l.cabys}" maxlength="13" onchange="updateLine(${idx},'cabys',this.value)" style="width:118px" /></td>
        <td><input value="${l.description}" onchange="updateLine(${idx},'description',this.value)" style="min-width:170px" /></td>
        <td><input value="${l.unit}" onchange="updateLine(${idx},'unit',this.value)" style="width:55px" /></td>
        <td><input type="number" step="0.01" value="${l.quantity}" onchange="updateLine(${idx},'quantity',this.value)" style="width:65px" /></td>
        <td><input type="number" step="0.01" value="${l.unit_price}" onchange="updateLine(${idx},'unit_price',this.value)" style="width:95px" /></td>
        <td><input type="number" step="0.01" value="${l.discount}" onchange="updateLine(${idx},'discount',this.value)" style="width:75px" /></td>
        <td><input type="number" step="1" value="${l.tax_rate}" onchange="updateLine(${idx},'tax_rate',this.value)" style="width:60px" /></td>
        <td class="mono">${money(lineTot, cur)}</td>
        <td><button type="button" class="btn btn-sm btn-danger" onclick="removeLine(${idx})">✕</button></td>
      </tr>`;
    })
    .join("");

  document.getElementById("sumSubtotal").textContent = money(sub, cur);
  document.getElementById("sumDiscount").textContent = money(disc, cur);
  document.getElementById("sumTax").textContent = money(tax, cur);
  document.getElementById("sumTotal").textContent = money(tot, cur);
}

document.getElementById("emitForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = {
      doc_type: document.getElementById("docType").value,
      currency: document.getElementById("currency").value,
      exchange_rate: Number(document.getElementById("exchangeRate").value || 1),
      sale_condition: document.getElementById("saleCondition").value,
      payment_method: document.getElementById("paymentMethod").value,
      credit_term_days: Number(document.getElementById("creditTerm").value || 0),
      client_id: Number(document.getElementById("clientSelect").value) || null,
      client_id_type: document.getElementById("clientIdType").value,
      client_name: document.getElementById("clientName").value,
      client_id_number: document.getElementById("clientIdNumber").value,
      client_email: document.getElementById("clientEmail").value,
      ref_clave: document.getElementById("refClave").value,
      ref_code: document.getElementById("refCode").value,
      ref_reason: document.getElementById("refReason").value,
      notes: document.getElementById("invoiceNotes").value,
      send_to_hacienda: document.getElementById("sendImmediately").checked,
      lines: emitLines,
    };
    const inv = await api("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast(`Comprobante ${inv.consecutive} creado (${inv.status})`);
    switchView("invoices");
  } catch (err) {
    showToast(err.message, true);
  }
});

// === HISTORIAL ===
async function loadInvoices() {
  const rows = await api("/api/invoices");
  document.getElementById("invoicesTableBody").innerHTML =
    rows.length === 0
      ? `<tr><td colspan="7" class="muted">No hay comprobantes todavía.</td></tr>`
      : rows
          .map(
            (inv) => `
      <tr>
        <td><strong>${DOC_LABELS[inv.doc_type] || inv.doc_type}</strong></td>
        <td>
          <div class="mono">${inv.consecutive}</div>
          <div class="mono muted">${inv.clave}</div>
        </td>
        <td class="mono">${inv.issue_date.slice(0, 16).replace("T", " ")}</td>
        <td>${inv.client_name}</td>
        <td>${money(inv.total, inv.currency)}</td>
        <td>
          <span class="badge badge-${inv.status}">${inv.status}</span>
          <div class="muted" style="font-size:11px;max-width:220px;">${inv.hacienda_message || ""}</div>
        </td>
        <td>
          <div class="inline-actions">
            <button class="btn btn-sm" onclick="sendInvoice(${inv.id})">Enviar</button>
            <button class="btn btn-sm" onclick="checkInvoice(${inv.id})">Consultar</button>
            <a class="btn btn-sm" href="/api/invoices/${inv.id}/pdf" target="_blank">PDF</a>
            <a class="btn btn-sm" href="/api/invoices/${inv.id}/xml">XML</a>
            ${
              inv.doc_type === "01"
                ? `<button class="btn btn-sm" onclick="makeCreditNote('${inv.clave}')">NC</button>`
                : ""
            }
          </div>
        </td>
      </tr>`
          )
          .join("");
}

async function sendInvoice(id) {
  try {
    const inv = await api(`/api/invoices/${id}/send`, { method: "POST" });
    showToast(`Comprobante ${inv.consecutive}: ${inv.status}`);
    loadInvoices();
  } catch (err) {
    showToast(err.message, true);
    loadInvoices();
  }
}

async function checkInvoice(id) {
  try {
    const inv = await api(`/api/invoices/${id}/check`, { method: "POST" });
    showToast(`Estado Hacienda: ${inv.status}`);
    loadInvoices();
  } catch (err) {
    showToast(err.message, true);
  }
}

function makeCreditNote(clave) {
  switchView("emit");
  document.getElementById("docType").value = "03";
  toggleRefFields();
  document.getElementById("refClave").value = clave;
  document.getElementById("refReason").value = "Anulación total de factura";
}

// === CONFIGURACIÓN EMISOR ===
async function loadEmitterConfig() {
  const cfg = await api("/api/emitter");
  document.getElementById("cfgEnv").value = cfg.environment;
  document.getElementById("cfgActivity").value = cfg.activity_code;
  document.getElementById("cfgName").value = cfg.name;
  document.getElementById("cfgCommName").value = cfg.commercial_name || "";
  document.getElementById("cfgIdType").value = cfg.id_type;
  document.getElementById("cfgIdNumber").value = cfg.id_number;
  document.getElementById("cfgEmail").value = cfg.email;
  document.getElementById("cfgPhone").value = cfg.phone_number;
  document.getElementById("cfgBranch").value = cfg.branch;
  document.getElementById("cfgTerminal").value = cfg.terminal;
  document.getElementById("cfgAddress").value = cfg.address_detail;
  document.getElementById("cfgAtvUser").value = cfg.atv_username || "";
  document.getElementById("cfgAtvPass").value = cfg.atv_password || "";

  document.getElementById("p12StatusBox").innerHTML = cfg.p12_uploaded
    ? `✅ Certificado activo: <strong>${cfg.p12_subject}</strong><br><span class="muted">Válido hasta: ${cfg.p12_valid_to}</span>`
    : `⚠️ No hay certificado <code>.p12</code> cargado todavía.`;
}

document.getElementById("emitterForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/emitter", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        environment: document.getElementById("cfgEnv").value,
        activity_code: document.getElementById("cfgActivity").value,
        name: document.getElementById("cfgName").value,
        commercial_name: document.getElementById("cfgCommName").value,
        id_type: document.getElementById("cfgIdType").value,
        id_number: document.getElementById("cfgIdNumber").value,
        email: document.getElementById("cfgEmail").value,
        phone_number: document.getElementById("cfgPhone").value,
        branch: document.getElementById("cfgBranch").value,
        terminal: document.getElementById("cfgTerminal").value,
        address_detail: document.getElementById("cfgAddress").value,
        atv_username: document.getElementById("cfgAtvUser").value,
        atv_password: document.getElementById("cfgAtvPass").value,
      }),
    });
    showToast("Configuración del Emisor guardada");
    loadDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById("p12Form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const fd = new FormData();
    fd.append("p12", document.getElementById("p12File").files[0]);
    fd.append("pin", document.getElementById("p12Pin").value);
    const res = await api("/api/emitter/p12", { method: "POST", body: fd });
    showToast(`Certificado validado: ${res.subject}`);
    loadEmitterConfig();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function testAtvAuth() {
  try {
    const res = await api("/api/emitter/test-auth", { method: "POST" });
    showToast(`Conexión exitosa a Hacienda (${res.environment}): ${res.tokenPreview}`);
  } catch (err) {
    showToast(err.message, true);
  }
}

// Init
addEmptyLine();
loadDashboard();
