const fs = require("fs");
const crypto = require("crypto");
const forge = require("node-forge");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");

// Política de firma electrónica oficial DGT Hacienda Costa Rica
const POLICY_URL =
  "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica";
const POLICY_HASH_B64 = crypto.createHash("sha256").update(POLICY_URL).digest("base64");

/**
 * Lee e inspecciona un certificado .p12 (llave criptográfica de Hacienda)
 */
function parseP12(p12Buffer, pin) {
  const p12Der = forge.util.createBuffer(p12Buffer.toString("binary"));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, String(pin || ""));

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyObj = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0]?.key;
  if (!keyObj) throw new Error("No se encontró llave privada en el archivo .p12");

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certObj = (certBags[forge.pki.oids.certBag] || [])[0]?.cert;
  if (!certObj) throw new Error("No se encontró certificado X.509 en el archivo .p12");

  const privateKeyPem = forge.pki.privateKeyToPem(keyObj);
  const certDerBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(certObj)).getBytes();
  const certBase64 = forge.util.encode64(certDerBytes);
  const certSha256B64 = crypto
    .createHash("sha256")
    .update(Buffer.from(certDerBytes, "binary"))
    .digest("base64");

  const subjectCN =
    certObj.subject.attributes.find((a) => a.shortName === "CN")?.value ||
    certObj.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(", ");
  const issuerName = certObj.issuer.attributes
    .slice()
    .reverse()
    .map((a) => `${a.shortName || a.name}=${a.value}`)
    .join(", ");
  const serialDecimal = BigInt("0x" + certObj.serialNumber).toString(10);

  return {
    privateKeyPem,
    certBase64,
    certSha256B64,
    subjectCN,
    issuerName,
    serialDecimal,
    validFrom: certObj.validity.notBefore.toISOString(),
    validTo: certObj.validity.notAfter.toISOString(),
  };
}

function sha256Base64(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("base64");
}

/**
 * Firma un XML de comprobante electrónico con XAdES-EPES (RSA-SHA256)
 */
function signXmlXadesEpes(xmlString, p12Path, pin) {
  if (!p12Path || !fs.existsSync(p12Path)) {
    throw new Error("No hay archivo .p12 configurado en el Emisor.");
  }
  const p12Buffer = fs.readFileSync(p12Path);
  const certInfo = parseP12(p12Buffer, pin);

  const doc = new DOMParser().parseFromString(xmlString, "text/xml");
  const root = doc.documentElement;
  const serializer = new XMLSerializer();

  // Digest del documento original (enveloped)
  const docCanonical = serializer.serializeToString(root);
  const docDigestB64 = sha256Base64(docCanonical);

  const idSuffix = crypto.randomBytes(4).toString("hex");
  const sigId = `Signature-${idSuffix}`;
  const sigValId = `SignatureValue-${idSuffix}`;
  const keyInfoId = `KeyInfo-${idSuffix}`;
  const refDocId = `Reference-${idSuffix}`;
  const signedPropsId = `SignedProperties-${idSuffix}`;
  const signingTime = new Date().toISOString();

  const signedPropertiesXml = `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="${signedPropsId}"><xades:SignedSignatureProperties><xades:SigningTime>${signingTime}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certInfo.certSha256B64}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certInfo.issuerName}</ds:X509IssuerName><ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certInfo.serialDecimal}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate><xades:SignaturePolicyIdentifier><xades:SignaturePolicyId><xades:SigPolicyId><xades:Identifier>${POLICY_URL}</xades:Identifier></xades:SigPolicyId><xades:SigPolicyHash><ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${POLICY_HASH_B64}</ds:DigestValue></xades:SigPolicyHash></xades:SignaturePolicyId></xades:SignaturePolicyIdentifier></xades:SignedSignatureProperties><xades:SignedDataObjectProperties><xades:DataObjectFormat ObjectReference="#${refDocId}"><xades:MimeType>text/xml</xades:MimeType><xades:Encoding>UTF-8</xades:Encoding></xades:DataObjectFormat></xades:SignedDataObjectProperties></xades:SignedProperties>`;

  const keyInfoXml = `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${keyInfoId}"><ds:X509Data><ds:X509Certificate>${certInfo.certBase64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`;

  const signedPropsDigestB64 = sha256Base64(signedPropertiesXml);
  const keyInfoDigestB64 = sha256Base64(keyInfoXml);

  const signedInfoXml = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference Id="${refDocId}" URI=""><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${docDigestB64}</ds:DigestValue></ds:Reference><ds:Reference URI="#${keyInfoId}"><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${keyInfoDigestB64}</ds:DigestValue></ds:Reference><ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropsId}"><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${signedPropsDigestB64}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signedInfoXml, "utf8");
  const signatureValueB64 = signer.sign(certInfo.privateKeyPem, "base64");

  const signatureBlock = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${sigId}">${signedInfoXml}<ds:SignatureValue Id="${sigValId}">${signatureValueB64}</ds:SignatureValue>${keyInfoXml}<ds:Object Id="XadesObject-${idSuffix}"><xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${sigId}">${signedPropertiesXml}</xades:QualifyingProperties></ds:Object></ds:Signature>`;

  const sigNode = new DOMParser().parseFromString(signatureBlock, "text/xml").documentElement;
  root.appendChild(doc.importNode(sigNode, true));

  return {
    signedXml: serializer.serializeToString(doc),
    certSubject: certInfo.subjectCN,
    certValidTo: certInfo.validTo,
  };
}

module.exports = {
  parseP12,
  signXmlXadesEpes,
};
