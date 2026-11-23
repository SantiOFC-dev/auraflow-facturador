const ENDPOINTS = {
  sandbox: {
    idp: "https://idp.comprobanteselectronicos.go.cr/auth/realms/rut-stag/protocol/openid-connect/token",
    clientId: "api-stag",
    apiBase: "https://api.comprobanteselectronicos.go.cr/recepcion-sandbox/v1",
  },
  prod: {
    idp: "https://idp.comprobanteselectronicos.go.cr/auth/realms/rut/protocol/openid-connect/token",
    clientId: "api-prod",
    apiBase: "https://api.comprobanteselectronicos.go.cr/recepcion/v1",
  },
};

const tokenCache = {
  sandbox: { token: null, expiresAt: 0 },
  prod: { token: null, expiresAt: 0 },
};

/**
 * Obtiene Access Token OAuth2 del IdP de Hacienda Costa Rica
 */
async function getAccessToken(environment, username, password) {
  const envKey = environment === "prod" ? "prod" : "sandbox";
  const cfg = ENDPOINTS[envKey];

  if (!username || !password) {
    throw new Error("Faltan usuario y contraseña API ATV en Configuración del Emisor.");
  }

  const cached = tokenCache[envKey];
  if (cached.token && Date.now() < cached.expiresAt - 30000) {
    return cached.token;
  }

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: cfg.clientId,
    username: username.trim(),
    password: password,
  });

  const res = await fetch(cfg.idp, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Error IdP Hacienda (${res.status}): ${data.error_description || data.error || "Credenciales inválidas"}`
    );
  }

  cached.token = data.access_token;
  cached.expiresAt = Date.now() + Number(data.expires_in || 300) * 1000;
  return cached.token;
}

/**
 * Envía el comprobante firmado en Base64 a POST /recepcion
 */
async function sendComprobante({ emitter, invoice, signedXml }) {
  const envKey = emitter.environment === "prod" ? "prod" : "sandbox";
  const cfg = ENDPOINTS[envKey];
  const token = await getAccessToken(envKey, emitter.atv_username, emitter.atv_password);

  const payload = {
    clave: invoice.clave,
    fecha: invoice.issue_date,
    emisor: {
      tipoIdentificacion: emitter.id_type || "02",
      numeroIdentificacion: String(emitter.id_number || "").replace(/\D/g, ""),
    },
    comprobanteXml: Buffer.from(signedXml, "utf8").toString("base64"),
  };

  if (invoice.client_id_number && invoice.doc_type !== "04") {
    payload.receptor = {
      tipoIdentificacion: invoice.client_id_type || "01",
      numeroIdentificacion: String(invoice.client_id_number).replace(/\D/g, ""),
    };
  }

  const res = await fetch(`${cfg.apiBase}/recepcion`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 202 || res.status === 200) {
    return { ok: true, status: "enviado", message: "Recibido por Hacienda (en procesamiento)" };
  }

  const errText = await res.text();
  throw new Error(`Hacienda rechazó recepción (${res.status}): ${errText || res.statusText}`);
}

/**
 * Consulta el estado de un comprobante por clave en GET /recepcion/{clave}
 */
async function queryComprobanteStatus({ emitter, clave }) {
  const envKey = emitter.environment === "prod" ? "prod" : "sandbox";
  const cfg = ENDPOINTS[envKey];
  const token = await getAccessToken(envKey, emitter.atv_username, emitter.atv_password);

  const res = await fetch(`${cfg.apiBase}/recepcion/${encodeURIComponent(clave)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error consultando clave (${res.status}): ${errText || res.statusText}`);
  }

  const data = await res.json();
  let responseXml = "";
  if (data["respuesta-xml"]) {
    responseXml = Buffer.from(data["respuesta-xml"], "base64").toString("utf8");
  }

  return {
    indEstado: data["ind-estado"] || "procesando",
    fecha: data.fecha || "",
    responseXml,
    raw: data,
  };
}

module.exports = {
  ENDPOINTS,
  getAccessToken,
  sendComprobante,
  queryComprobanteStatus,
};
