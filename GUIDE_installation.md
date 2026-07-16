# Suivi automatique des prix de vols — Corée du Sud (octobre)

Pourquoi pas via FlightList directement : FlightList n'a pas d'API publique
pour toi — leur recherche flexible s'appuie en coulisses sur l'API Kiwi
Tequila avec une clé propre à leur site, et cette API est désormais fermée
aux nouveaux projets perso (accès conditionné à 50 000 utilisateurs actifs/mois
depuis 2026). Amadeus, l'autre grande API du secteur, ferme aussi ses
inscriptions le 17 juillet 2026. Rebâtir "FlightList" à l'identique n'est donc
plus possible avec des outils gratuits.

**La solution ci-dessous fait le même travail** (comparaison de dizaines
d'aéroports européens, dates flexibles, vols directs et avec escales) via une
source différente : l'API gratuite Travelpayouts/Aviasales. Elle tourne sur
les serveurs Google (Apps Script), donc 24h/24 et 7j/7, sans que ton
ordinateur ou une app soit ouverte — et se pilote entièrement depuis Telegram.

⚠️ Les prix viennent d'un cache (recherches réelles d'autres utilisateurs,
jusqu'à ~48h) — parfait pour repérer une tendance ou une bonne affaire, mais
vérifie toujours le prix exact avant de payer.

## Étape 1 — Token Travelpayouts (gratuit, ~2 min)

1. Va sur https://www.travelpayouts.com/ et crée un compte (inscription
   "affilié", gratuite, aucune validation manuelle nécessaire pour l'API Data).
2. Une fois connecté, va dans ton Profil → section **API token** :
   https://app.travelpayouts.com/profile/api-token
3. Copie le token.

## Étape 2 — Bot Telegram (gratuit, ~2 min)

1. Dans Telegram, cherche **@BotFather** et envoie `/start` puis `/newbot`.
2. Donne un nom et un identifiant (doit finir par "bot", ex. `coree_flights_bot`).
3. BotFather te donne un **token** (garde-le secret).
4. Envoie n'importe quel message à ton nouveau bot (cherche-le par son nom
   d'utilisateur et clique "Démarrer").
5. Récupère ton **chat_id** : le plus simple est d'envoyer n'importe quoi au
   bot **@userinfobot** dans Telegram — il répond avec ton id numérique.
   (Alternative : ouvre `https://api.telegram.org/bot<TON_TOKEN>/getUpdates`
   dans ton navigateur et cherche `"chat":{"id":123456789` dans la réponse.)

## Étape 3 — Installer le script

1. Va sur https://script.google.com → **Nouveau projet**.
2. Supprime le code par défaut, colle tout le contenu de
   `flight_price_watch.gs` (fourni à côté de ce guide).
3. Tout en haut du fichier, remplis le bloc `CONFIG_STATIC` — seules ces
   3 lignes sont indispensables, tout le reste se règle ensuite dans Telegram :
   - `TRAVELPAYOUTS_TOKEN` → le token de l'étape 1
   - `TELEGRAM_BOT_TOKEN` → le token de l'étape 2
   - `TELEGRAM_CHAT_ID` → le chat_id de l'étape 2

   (Les valeurs `DEFAULT_*` en dessous — destinations, zone de départ,
   fenêtres de dates, devises… — ne sont que des points de départ proposés
   par l'assistant, modifie-les seulement si tu veux d'autres défauts.)
4. Renomme le projet (en haut à gauche) en quelque chose comme
   "Suivi vols".
5. Dans la barre d'outils, sélectionne la fonction **setup** puis clique
   **Exécuter** (▶). Google va demander d'autoriser le script (accès à
   Google Sheets, Drive, et aux requêtes externes) — accepte.

C'est tout. Si les tokens sont bons, le bot t'écrit immédiatement sur
Telegram et lance **l'assistant de configuration : 8 questions rapides**
(destinations, zone de départ, fenêtre de dates aller, fenêtre retour,
durée du séjour en nuits, type de billet — éco / éco premium / affaires /
first —, escales max, budget max — avec en repère le meilleur prix et la
moyenne constatés sur ta recherche). Réponds simplement ; « passer » garde la valeur proposée,
`/annuler` garde tout par défaut. À la fin, il lance une première
vérification et t'envoie le top 3 des prix. Tu peux relancer l'assistant
n'importe quand avec `/config`.

**Pas de déploiement Web App, pas de webhook** : le script relève lui-même
tes messages Telegram toutes les minutes (polling). C'est un choix délibéré —
Apps Script répond aux webhooks par une redirection HTTP 302 que Telegram
considère comme un échec, source de bugs pénibles. Le polling est fiable, et
en bonus **toute modification du code prend effet immédiatement** après
sauvegarde (les triggers exécutent toujours la dernière version — aucun
redéploiement, jamais). Seule contrepartie : le bot répond en 1 minute maxi
au lieu d'instantanément.

## Commandes Telegram

- `/config` — relance l'assistant complet (8 questions)
- `/demarrer ICN` — ajoute ICN aux destinations suivies (et réactive la
  surveillance si elle était en pause) + vérification immédiate. Envoyer
  juste `ICN` (3 lettres, sans `/`) fait pareil.
- `/retirer ICN` — retire une destination (ou une ville de départ si le code
  correspond à un départ)
- `/ajouter FR` — ajoute un pays (étendu automatiquement) ou un aéroport de
  départ précis, ex. `/ajouter CDG`
- `/dates 2026-10-01 2026-10-14` — fenêtre de DÉPART (ou `/dates 2026-10`
  pour tout le mois)
- `/retour 2026-10-19 2026-11-03` — fenêtre de RETOUR
- `/duree 14 21` — durée du séjour min/max (nuits)
- `/cabines eco affaires` — type de billet suivi (éco, éco premium,
  affaires, first, toutes) ; l'éco est vérifiée toutes les 30 min, les
  cabines avant 1x/jour + `/premium`
- `/escales 1` — escales maxi par trajet (`/escales non` = peu importe)
- `/budget 700` — budget repère dans la devise principale : les prix
  au-dessus restent affichés, marqués ⚠️ (`/budget non` = aucun)
- `/devises EUR USD` — devises suivies ; la 1ère est la principale
- `/seuil 40` — alerte si un prix tombe 40 % sous la moyenne relevée
- `/pause` / `/reprendre` — suspend ou relance les vérifications automatiques
- `/check` — vérification immédiate, top 3 par destination + prix dans les
  autres devises
- `/premium` — vérifie éco premium / affaires / première à la demande
- `/liste` — récap complet de la config (et version du script)
- `/status` — derniers prix éco ET cabines premium
- `/aide` — rappel de toutes les commandes (+ version du script)

## Vérifier / consulter

Un Google Sheet est créé automatiquement dans ton Drive (onglet **"Log v2"**,
+ **"Log Premium"** pour les cabines). À chaque passage (toutes les 30 min),
le script enregistre les meilleurs prix par aéroport de départ, destination
et devise — tableau comparatif complet qui s'accumule tout seul.

Tous les prix sont **par personne, aller-retour complet**. Si ta config est
très large (beaucoup de destinations × aéroports de départ), les
vérifications passent automatiquement à 1x/heure pour rester dans les
quotas gratuits Google — `/liste` l'indique.

Tu reçois un message Telegram **seulement** quand, pour une destination et
une devise données :
- le meilleur prix bat son record historique, ou
- le prix tombe X % sous la médiane des ~30 derniers relevés (X = ton
  `/seuil`, 40 % par défaut → probable **erreur de prix**)
— et jamais deux alertes pour le même prix.

## Mettre à jour le script

Colle le nouveau code, sauvegarde (Cmd/Ctrl+S) — c'est tout, les triggers
exécutent toujours la dernière version enregistrée. Ré-exécute `setup()`
uniquement si la mise à jour ajoute ou renomme un trigger (le changelog le
précisera) : `setup()` est ré-exécutable sans risque, il ne perd ni ta
config ni ton historique. Vérifie avec `/aide` que la version affichée
correspond à `SCRIPT_VERSION` en haut du code.

## Module complémentaire — éco premium / affaires / première

Travelpayouts ne sait pas filtrer par cabine. Ce module interroge donc
directement Google Flights (la même requête que ton navigateur), une fois
par jour seulement (vers 8h), pour un nombre limité de villes — volontairement
peu fréquent pour rester discret.

**À savoir avant de t'y fier :**
- C'est un scraping non officiel, pas une API sanctionnée comme Travelpayouts.
  Ça peut casser sans prévenir si Google modifie sa page — c'est pour ça que
  chaque appel est protégé individuellement : si ce module tombe en panne, le
  suivi éco principal continue de tourner normalement, sans aucune coupure.
- Google Flights exige des dates précises (pas de fenêtre flexible) : le
  module échantillonne automatiquement le début de ta fenêtre de départ +
  un séjour de durée moyenne (entre tes bornes min/max).
- Les résultats vont dans un second onglet du même Google Sheet : **"Log
  Premium"**, et apparaissent dans `/status`. `/premium` force une
  vérification à la demande.
- Alerte Telegram séparée dès qu'une cabine (éco premium, affaires ou
  première) bat son record précédent, avec un rappel qu'il faut revérifier
  le prix avant de réserver.
- Les cabines suivies se choisissent dans l'onboarding ou via `/cabines`.
  Réglages avancés (`PREMIUM_ENABLED`, `PREMIUM_MAX_ORIGINS`) dans
  `CONFIG_STATIC` — relus à chaque passage, sauf pour activer/désactiver le
  trigger quotidien lui-même (relance `setup`).

## Pour arrêter ou ajuster

- `/pause` sur Telegram suspend les deux modules (éco et premium) sans tout
  démonter ; `/demarrer` ou `/reprendre` relance.
- Pour arrêter complètement (supprimer les triggers) : exécute la fonction
  **stop** dans l'éditeur Apps Script.
- Absolument tous les critères de recherche (destinations, zone de départ,
  fenêtres de dates, durée, escales, budget, devises, seuil d'alerte) se
  pilotent par Telegram — `/config` pour l'assistant, ou les commandes une
  par une. Plus rien à modifier dans le code au quotidien.
