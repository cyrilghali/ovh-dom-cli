// Client API Cloudflare minimal — le token vient de CF_API_TOKEN. Zéro dépendance.

const API = "https://api.cloudflare.com/client/v4";

function token() {
  const t = process.env.CF_API_TOKEN;
  if (!t) throw new Error("CF_API_TOKEN manquant (token API Cloudflare).");
  return t;
}

async function cf(method, path, body = null) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!j.success) {
    const msg = (j.errors || []).map((e) => e.message).join(" ; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare ${method} ${path} : ${msg}`);
  }
  return j.result;
}

export async function verify() {
  return cf("GET", "/user/tokens/verify");
}
export async function accountId() {
  // Un token « Zone » ne peut souvent pas lister /accounts → on récupère l'ID de
  // compte depuis une zone existante (repli sur /accounts si aucune zone).
  const z = await cf("GET", "/zones?per_page=1");
  if (z[0]?.account?.id) return z[0].account.id;
  const a = await cf("GET", "/accounts?per_page=1");
  return a[0]?.id ?? null;
}
export async function zoneByName(name) {
  const z = await cf("GET", `/zones?name=${encodeURIComponent(name)}`);
  return z[0] ?? null;
}
export async function createZone(name, account) {
  return cf("POST", "/zones", { name, account: { id: account }, type: "full" });
}
export async function listRecords(zoneId) {
  return cf("GET", `/zones/${zoneId}/dns_records?per_page=200`);
}
export async function createRecord(zoneId, rec) {
  return cf("POST", `/zones/${zoneId}/dns_records`, rec);
}
