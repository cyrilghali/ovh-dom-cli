// Client API OVHcloud minimal — requêtes signées, zéro dépendance.
//
// Signature OVH (documentée) :
//   preHash   = AS + "+" + CK + "+" + METHOD + "+" + URL_COMPLETE + "+" + BODY + "+" + TS
//   signature = "$1$" + sha1hex(preHash)
// En-têtes : X-Ovh-Application (AK), X-Ovh-Consumer (CK), X-Ovh-Timestamp (TS),
//            X-Ovh-Signature. Le TS vient de l'horloge SERVEUR (/auth/time) pour
//            éviter tout décalage. GET /auth/time est public (non signé).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ENDPOINT = "https://eu.api.ovh.com/1.0";

export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".ovhdom.json"), "utf8"));
  } catch {
    /* pas de fichier de conf : on s'appuiera sur l'environnement */
  }
  return {
    endpoint: process.env.OVH_ENDPOINT || file.endpoint || DEFAULT_ENDPOINT,
    ak: process.env.OVH_AK || file.applicationKey,
    as: process.env.OVH_AS || file.applicationSecret,
    ck: process.env.OVH_CK || file.consumerKey,
    subsidiary: process.env.OVH_SUBSIDIARY || file.subsidiary || "FR",
  };
}

/** Signature OVH (exportée pour l'auto-test, pure). */
export function sign(as, ck, method, url, body, ts) {
  const pre = `${as}+${ck}+${method}+${url}+${body}+${ts}`;
  return "$1$" + crypto.createHash("sha1").update(pre).digest("hex");
}

let _timeDelta = null; // (heure serveur − heure locale) en secondes, mesuré une fois
async function serverTimestamp(endpoint) {
  if (_timeDelta === null) {
    const res = await fetch(`${endpoint}/auth/time`);
    if (!res.ok) throw new Error(`GET /auth/time → ${res.status}`);
    const serverT = Number(await res.text());
    _timeDelta = serverT - Math.floor(Date.now() / 1000);
  }
  return Math.floor(Date.now() / 1000) + _timeDelta;
}

/** Appel API. `path` inclut la query éventuelle (elle entre dans la signature). */
export async function ovh(method, apiPath, body = null, { auth = true } = {}) {
  const cfg = loadConfig();
  const url = `${cfg.endpoint}${apiPath}`;
  const bodyStr = body != null ? JSON.stringify(body) : "";
  const headers = { Accept: "application/json" };
  if (bodyStr) headers["Content-Type"] = "application/json";

  if (auth) {
    if (!cfg.ak || !cfg.as || !cfg.ck) {
      throw new Error(
        "Identifiants OVH manquants. Renseigne OVH_AK / OVH_AS / OVH_CK (ou ~/.ovhdom.json). Voir `ovhdom help`.",
      );
    }
    const ts = await serverTimestamp(cfg.endpoint);
    headers["X-Ovh-Application"] = cfg.ak;
    headers["X-Ovh-Consumer"] = cfg.ck;
    headers["X-Ovh-Timestamp"] = String(ts);
    headers["X-Ovh-Signature"] = sign(cfg.as, cfg.ck, method, url, bodyStr, ts);
  }

  const res = await fetch(url, { method, headers, body: bodyStr || undefined });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = json && json.message ? json.message : text || res.statusText;
    throw new Error(`OVH ${res.status} ${method} ${apiPath} : ${msg}`);
  }
  return json;
}
