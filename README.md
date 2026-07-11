# ovh-dom-cli

Acheter et gérer des **noms de domaine OVHcloud depuis le terminal**. Le CLI
officiel `ovhcloud` gère les services *existants* (DNS via `domain-zone`) mais
**ne commande pas** de nouveau domaine — chez OVH, commander passe par l'API
« panier » (`/order/cart`). Ce petit CLI l'encapsule. Zéro dépendance, juste Node.

```bash
node src/cli.mjs help
# ou, en global :  npm link  →  commande `ovhdom`
```

## 1. Créer les identifiants (une fois)

Génère un token sur **https://eu.api.ovh.com/createToken/** avec ces droits :

| Méthode | Chemin |
|---|---|
| GET | `/auth/time` |
| GET | `/me`, `/me/contact`, `/me/contact/*` |
| GET | `/domain/*` |
| GET, POST, PUT | `/order/cart`, `/order/cart/*` |

Tu obtiens **Application Key (AK)**, **Application Secret (AS)** et
**Consumer Key (CK)**. Renseigne-les par variables d'env :

```bash
export OVH_AK=... OVH_AS=... OVH_CK=...
```

ou dans `~/.ovhdom.json` (jamais committé) :

```json
{ "applicationKey": "...", "applicationSecret": "...", "consumerKey": "...", "subsidiary": "FR" }
```

> Endpoint par défaut : `https://eu.api.ovh.com/1.0` (OVH Europe). Surcharge avec
> `OVH_ENDPOINT` si besoin (ex. `ca.api.ovhcloud.com` pour OVH Canada).

## 2. Utilisation

```bash
ovhdom time                 # horloge serveur OVH — public, teste la connexion
ovhdom whoami               # identité du compte — teste tes identifiants
ovhdom contacts             # liste tes contacts (IDs pour --owner)
ovhdom check lederniercouvert.fr        # dispo + prix, ne débite RIEN
ovhdom order lederniercouvert.fr --owner <id> --yes --auto-pay
```

### La commande `order`

Elle exécute un **achat réel** (elle dépense de l'argent). Séquence :

1. crée un panier (`/order/cart`) et l'assigne à ton compte ;
2. ajoute le domaine (`/order/cart/{id}/domain`, durée `--duration`, défaut `P1Y`) ;
3. renseigne le **contact titulaire** si l'extension l'exige — **obligatoire en
   `.fr`** : passe `--owner <id>` (voir `ovhdom contacts`) ;
4. affiche le **récapitulatif de prix** puis s'arrête — rien n'est acheté tant
   que tu n'ajoutes pas `--yes` (dry-run par défaut) ;
5. avec `--yes` : passe la commande. Ajoute `--auto-pay` pour régler via ton
   moyen de paiement OVH par défaut ; sinon, un lien de paiement est affiché.

## Sécurité

- `~/.ovhdom.json` et les clés ne sont jamais committés (voir `.gitignore`).
- Restreins le token OVH aux seuls droits ci-dessus, et à ton IP si possible
  (option lors de la création du token).
- `order` sans `--yes` ne débite jamais : utilise-le pour voir le prix d'abord.

## État / tests

`time` (API publique) et `selftest` (format de signature) sont vérifiés hors
identifiants. `whoami`, `contacts`, `check`, `order` suivent l'API panier
documentée d'OVH mais nécessitent un vrai token pour être exercés de bout en bout
(et `order` engage une dépense) — teste d'abord `whoami` puis `check`.
