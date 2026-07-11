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
