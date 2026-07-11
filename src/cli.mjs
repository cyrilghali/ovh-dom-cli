#!/usr/bin/env node
// ovhdom — acheter et gérer des domaines OVHcloud depuis le terminal.
//
//   ovhdom time                 horloge serveur OVH (public, teste la connexion)
//   ovhdom whoami               identité du compte (teste tes identifiants)
//   ovhdom contacts             liste tes contacts (IDs à passer en --owner)
//   ovhdom check <domaine>      dispo + prix (crée un panier, ne débite rien)
//   ovhdom order <domaine> [opts]   ENREGISTRE le domaine (dépense réelle)
//     --owner <id>     contact titulaire (obligatoire en .fr) — voir `contacts`
//     --duration P1Y   durée (défaut P1Y)
//     --auto-pay       paie via ton moyen de paiement par défaut
//     --yes            confirme l'achat (sans, on s'arrête au récap = dry-run)
//   ovhdom selftest             vérifie la signature (hors-ligne)

import * as cf from "./cf.mjs";
import { loadConfig, ovh, sign } from "./ovh.mjs";

const [, , cmd, ...rest] = process.argv;

function opt(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
function flag(name) {
  return rest.includes(`--${name}`);
}
function positional() {
  return rest.find((a) => !a.startsWith("--"));
}
function firstPrice(prices) {
  if (!Array.isArray(prices)) return null;
  const total = prices.find((p) => p.label === "TOTAL") || prices[0];
  return total?.price?.text ?? null;
}

const HELP = `ovhdom — domaines OVHcloud en ligne de commande

  ovhdom time                     horloge serveur OVH (public)
  ovhdom whoami                   identité du compte (teste les identifiants)
  ovhdom contacts                 liste des contacts (IDs pour --owner)
  ovhdom check <domaine>          disponibilité + prix (ne débite rien)
  ovhdom order <domaine> [opts]   enregistre le domaine (DÉPENSE RÉELLE)
      --owner <id>   contact titulaire (obligatoire en .fr)
      --duration P1Y durée (défaut P1Y)
      --auto-pay     paie via le moyen de paiement par défaut
      --yes          confirme (sinon : récap seul, rien n'est acheté)
  ovhdom cf-migrate <domaine> [--apply] [--proxy]
                                  migre le DNS OVH → Cloudflare (crée la zone,
                                  importe les records, bascule les NS). Dry-run
                                  par défaut ; besoin de CF_API_TOKEN.
  ovhdom selftest                 auto-test de la signature (hors-ligne)

Identifiants : crée un token sur https://eu.api.ovh.com/createToken/
(droits GET/POST/PUT sur /order/*, GET /me*, GET /auth/time, GET /domain/*),
puis renseigne OVH_AK / OVH_AS / OVH_CK en variables d'env ou dans ~/.ovhdom.json.`;

async function newCart() {
  const cfg = loadConfig();
  const cart = await ovh("POST", "/order/cart", { ovhSubsidiary: cfg.subsidiary, description: "ovhdom" });
  return cart.cartId;
}

async function check(domain) {
  if (!domain) throw new Error("Usage : ovhdom check <domaine>");
  const cartId = await newCart();
  const offers = await ovh("GET", `/order/cart/${cartId}/domain?domain=${encodeURIComponent(domain)}`);
  if (!Array.isArray(offers) || offers.length === 0) {
    console.log(`${domain} : aucune offre (extension non vendue par OVH ?)`);
    return;
  }
  for (const o of offers) {
    const orderable = o.orderable ?? false;
    const price = firstPrice(o.prices);
    console.log(`${domain} · ${o.action ?? "?"} · ${orderable ? "DISPONIBLE" : "indisponible"}${price ? ` · ${price}` : ""}`);
  }
}

async function order(domain) {
  if (!domain) throw new Error("Usage : ovhdom order <domaine> [--owner <id>] [--yes] [--auto-pay]");
  const duration = opt("duration") || "P1Y";
  const owner = opt("owner");
  const cartId = await newCart();
  await ovh("POST", `/order/cart/${cartId}/assign`);
  const item = await ovh("POST", `/order/cart/${cartId}/domain`, { domain, duration });

  const required = await ovh("GET", `/order/cart/${cartId}/item/${item.itemId}/requiredConfiguration`);
  const needsOwner = Array.isArray(required) && required.some((r) => r.label === "OWNER_CONTACT");
  if (needsOwner) {
    if (!owner) {
      console.log(
        `Ce domaine exige un contact titulaire (OWNER_CONTACT). Liste tes contacts avec \`ovhdom contacts\` puis relance avec --owner <id>.`,
      );
      return;
    }
    await ovh("POST", `/order/cart/${cartId}/item/${item.itemId}/configuration`, {
      label: "OWNER_CONTACT",
      value: `/me/contact/${owner}`,
    });
  }

  const summary = await ovh("GET", `/order/cart/${cartId}/checkout`);
  console.log(`Récapitulatif pour ${domain} (${duration}) :`);
  console.log(`  Total : ${summary?.prices?.withTax?.text ?? summary?.prices?.withoutTax?.text ?? "?"}`);

  if (!flag("yes")) {
    console.log("\nRien n'a été acheté. Ajoute --yes pour confirmer l'enregistrement.");
    return;
  }
  const res = await ovh("POST", `/order/cart/${cartId}/checkout`, {
    autoPayWithPreferredPaymentMethod: flag("auto-pay"),
    waiveRetractationPeriod: true,
  });
  console.log(`\nCommande créée : #${res.orderId}`);
  if (res.url) console.log(`Suivi / paiement : ${res.url}`);
  if (!flag("auto-pay")) console.log("Ajoute --auto-pay pour régler automatiquement, sinon paie via le lien ci-dessus.");
}

// ── Migration DNS OVH → Cloudflare ────────────────────────────────────────────
// Lit la zone DNS OVH, (re)crée la zone Cloudflare + importe les enregistrements,
// puis bascule les serveurs de noms OVH vers Cloudflare. Dry-run par défaut ;
// --apply exécute. --proxy active le proxy CF (orange) sur A/AAAA/CNAME (défaut :
// DNS-only, recommandé pour un site Vercel).

const SKIP_TYPES = new Set(["NS", "SOA"]);
const OVH_PARK_IPS = new Set(["213.186.33.5"]);

// Enregistrements de parking OVH par défaut, sans valeur (à ne pas transporter
// sur Cloudflare). Contournable avec --all.
function isOvhParking(r) {
  const t = String(r.target).trim();
  if ((r.fieldType === "A" || r.fieldType === "AAAA") && OVH_PARK_IPS.has(t)) return true;
  if (r.fieldType === "TXT" && /^"?\d+\|/.test(t)) return true; // "1|www…", "3|welcome"
  if (r.fieldType === "CNAME" && r.subDomain === "ftp") return true;
  return false;
}

function ovhRecordToCf(r, domain, proxy) {
  const name = r.subDomain ? `${r.subDomain}.${domain}` : domain;
  // Cloudflare a retiré le type SPF (déprécié) : on le porte en TXT, sinon
  // POST /dns_records échoue (souvent avec un message d'erreur vide).
  const type = r.fieldType === "SPF" ? "TXT" : r.fieldType;
  const base = { type, name, ttl: r.ttl && r.ttl >= 60 ? r.ttl : 1 };
  if (type === "MX") {
    const m = String(r.target).trim().match(/^(\d+)\s+(.*)$/);
    return { ...base, priority: m ? Number(m[1]) : 0, content: (m ? m[2] : r.target).replace(/\.$/, "") };
  }
  if (type === "TXT") {
    // Contenu libre : ne pas rogner le point final. OVH encadre parfois la
    // valeur de guillemets ; Cloudflare les réajoute lui-même.
    return { ...base, content: String(r.target).trim().replace(/^"([\s\S]*)"$/, "$1") };
  }
  const proxied = proxy && ["A", "AAAA", "CNAME"].includes(type);
  return { ...base, content: String(r.target).replace(/\.$/, ""), proxied };
}

async function cfMigrate(domain) {
  if (!domain) throw new Error("Usage : ovhdom cf-migrate <domaine> [--apply] [--proxy]");
  const apply = flag("apply");
  const proxy = flag("proxy");

  const v = await cf.verify();
  console.log(`Cloudflare : token ${v.status === "active" ? "actif ✓" : v.status}`);

  // 1. Enregistrements DNS actuels chez OVH
  let ids = [];
  try {
    ids = await ovh("GET", `/domain/zone/${domain}/record`);
  } catch (e) {
    console.log(`Zone DNS OVH introuvable (${e.message.slice(0, 50)}) — le domaine n'a peut-être pas encore de zone.`);
  }
  const all = flag("all");
  const records = [];
  let parkingSkipped = 0;
  for (const id of ids) {
    const r = await ovh("GET", `/domain/zone/${domain}/record/${id}`);
    if (SKIP_TYPES.has(r.fieldType)) continue;
    if (!all && isOvhParking(r)) {
      parkingSkipped += 1;
      continue;
    }
    records.push(r);
  }
  console.log(`OVH : ${records.length} enregistrement(s) à importer${parkingSkipped ? ` (${parkingSkipped} parking OVH ignoré(s) ; --all pour tout garder)` : ""}.`);
  for (const r of records) {
    console.log(`  ${r.fieldType} ${r.subDomain || "@"} → ${r.target}`);
  }

  // 2. Zone Cloudflare
  let zone = await cf.zoneByName(domain);
  if (zone) {
    console.log(`Cloudflare : zone existante (${zone.status}). NS : ${(zone.name_servers || []).join(", ")}`);
  } else if (!apply) {
    console.log("Cloudflare : zone absente — --apply la créera et renverra les 2 serveurs de noms.");
  } else {
    const acc = await cf.accountId();
    zone = await cf.createZone(domain, acc);
    console.log(`Cloudflare : zone créée. NS : ${zone.name_servers.join(", ")}`);
  }

  if (!apply) {
    console.log(`\nDry-run. Ajoute --apply pour : créer la zone, importer ${records.length} record(s), puis basculer les NS OVH vers Cloudflare.`);
    return;
  }

  // 3. Import des enregistrements dans Cloudflare
  let imported = 0;
  const existing = new Set((await cf.listRecords(zone.id)).map((r) => `${r.type}|${r.name}|${r.content}`));
  for (const r of records) {
    const rec = ovhRecordToCf(r, domain, proxy);
    if (existing.has(`${rec.type}|${rec.name}|${rec.content}`)) continue;
    try {
      await cf.createRecord(zone.id, rec);
      imported += 1;
    } catch (e) {
      console.log(`  ⚠ ${rec.type} ${rec.name} non importé : ${e.message.slice(0, 70)}`);
    }
  }
  console.log(`Cloudflare : ${imported} enregistrement(s) importé(s).`);

  // 4. Bascule des serveurs de noms OVH → Cloudflare
  const ns = (zone.name_servers || []).map((host) => ({ host }));
  await ovh("POST", `/domain/${domain}/nameServers/update`, { nameServers: ns });
  console.log(`OVH : serveurs de noms basculés vers Cloudflare (${zone.name_servers.join(", ")}).`);
  console.log("Propagation : quelques minutes à quelques heures. Cloudflare activera la zone dès qu'il détecte ses NS.");
}

async function main() {
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    case "selftest": {
      const got = sign("AS", "CK", "GET", "https://eu.api.ovh.com/1.0/me", "", 1700000000);
      const ok = /^\$1\$[0-9a-f]{40}$/.test(got);
      console.log(`signature: ${got}`);
      console.log(ok ? "✓ format de signature valide" : "✗ format inattendu");
      process.exit(ok ? 0 : 1);
      return;
    }
    case "time":
      console.log(await ovh("GET", "/auth/time", null, { auth: false }));
      return;
    case "whoami": {
      const me = await ovh("GET", "/me");
      console.log(`${me.firstname ?? ""} ${me.name ?? ""} · ${me.nichandle} · ${me.email}`);
      return;
    }
    case "contacts": {
      const ids = await ovh("GET", "/me/contact");
      if (!ids?.length) {
        console.log("Aucun contact. Crée-en un dans ton compte OVH (ou via l'API /me/contact).");
        return;
      }
      for (const id of ids) {
        const c = await ovh("GET", `/me/contact/${id}`);
        console.log(`${id} · ${c.firstName ?? ""} ${c.lastName ?? ""} · ${c.email ?? ""}`);
      }
      return;
    }
    case "check":
      await check(positional());
      return;
    case "order":
      await order(positional());
      return;
    case "cf-migrate":
      await cfMigrate(positional());
      return;
    default:
      console.error(`Commande inconnue : ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("Erreur :", e.message);
  process.exit(1);
});
