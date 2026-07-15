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
3. Tout en haut du fichier, remplis le bloc `CONFIG_STATIC` :
   - `TRAVELPAYOUTS_TOKEN` → le token de l'étape 1
   - `TELEGRAM_BOT_TOKEN` → le token de l'étape 2
   - `TELEGRAM_CHAT_ID` → le chat_id de l'étape 2
   - `DEFAULT_DESTINATIONS` → destinations de départ (ex. `["SEL"]` = Séoul,
     ou `["ICN"]` pour ne cibler qu'Incheon) — ensuite tu en ajoutes/retires
     via Telegram (`/demarrer ICN`, `/retirer ICN`)
   - `DEFAULT_ORIGINS` → villes de départ, déjà pré-remplies avec des codes
     pays (`"FR"`, `"BE"`, `"NL"`, `"GB"`, `"DE"`, `"ES"`, `"IT"`, `"PT"`,
     `"CH"`) — chaque pays s'étend automatiquement vers ses aéroports
     principaux (voir `COUNTRY_AIRPORTS` juste en dessous dans le code)
   - `DEFAULT_CURRENCIES` → devises suivies, ex. `["EUR", "USD"]` — suivre
     plusieurs devises aide à repérer les erreurs de prix visibles dans une
     seule devise ; la 1ère est celle du seuil d'alerte
   - `DEFAULT_ALERT_BELOW` → seuil de prix de départ (dans la 1ère devise)
   - Ces valeurs `DEFAULT_*` ne servent qu'au tout premier lancement —
     ensuite tout se pilote via Telegram.
4. Renomme le projet (en haut à gauche) en quelque chose comme
   "Suivi vols Corée".
5. Dans la barre d'outils, sélectionne la fonction **setup** puis clique
   **Exécuter** (▶). Google va demander d'autoriser le script (accès à
   Google Sheets, Drive, et aux requêtes externes) — accepte.

C'est tout. Si les tokens sont bons, tu reçois immédiatement un message
Telegram « 🤖 Flight Price Watch installé et actif ! ». Envoie `/aide` pour
vérifier (réponse sous 1 minute).

**Pas de déploiement Web App, pas de webhook** : le script relève lui-même
tes messages Telegram toutes les minutes (polling). C'est un choix délibéré —
Apps Script répond aux webhooks par une redirection HTTP 302 que Telegram
considère comme un échec, source de bugs pénibles. Le polling est fiable, et
en bonus **toute modification du code prend effet immédiatement** après
sauvegarde (les triggers exécutent toujours la dernière version — aucun
redéploiement, jamais). Seule contrepartie : le bot répond en 1 minute maxi
au lieu d'instantanément.

## Commandes Telegram

- `/demarrer ICN` — ajoute ICN aux destinations suivies (et réactive la
  surveillance si elle était en pause) + vérification immédiate de cette
  destination. Envoyer juste `ICN` (3 lettres, sans `/`) fait pareil.
- `/retirer ICN` — retire une destination (ou une ville de départ si le code
  correspond à un départ)
- `/ajouter FR` — ajoute un pays (étendu automatiquement) ou un aéroport de
  départ précis, ex. `/ajouter CDG`
- `/devises EUR USD` — change les devises suivies ; la 1ère porte le seuil
- `/seuil 600` — change le seuil qui déclenche une alerte immédiate
- `/pause` / `/reprendre` — suspend ou relance les vérifications automatiques
- `/check` — force une vérification immédiate et renvoie un résumé des
  meilleurs prix par destination/devise
- `/liste` — affiche destinations, départs, devises, seuil, état
  (actif/pause) et la version du script
- `/status` — derniers meilleurs prix trouvés, sans attendre le prochain passage
- `/aide` — rappel de toutes les commandes (+ version du script)

## Vérifier / consulter

Un Google Sheet nommé **"Historique prix Corée du Sud"** est créé
automatiquement dans ton Drive (onglet **"Log v2"**). À chaque passage
(toutes les 30 min), le script enregistre le meilleur prix trouvé pour CHAQUE
aéroport surveillé, par destination et par devise — tableau comparatif
complet qui s'accumule tout seul.

Tu reçois un message Telegram **seulement** quand, pour une destination et
une devise données :
- le meilleur prix bat son record historique, ou
- le prix est anormalement bas par rapport aux ~30 derniers relevés
  (≤ 60 % de la médiane → probable **erreur de prix**), ou
- le prix passe sous ton seuil — une seule fois par baisse, jamais deux
  alertes pour le même prix.

Chaque alerte inclut le classement des 3 villes de départ les moins chères.

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
- Les prix sont calculés sur des dates fixes (`PREMIUM_SAMPLE_DEPART_DATE` /
  `PREMIUM_SAMPLE_RETURN_DATE` dans `CONFIG_STATIC`, 5 → 19 octobre 2026 par
  défaut) plutôt qu'un mois entier flexible — ajuste ces deux dates dans le
  code si tu vises d'autres dates précises.
- Les résultats vont dans un second onglet du même Google Sheet : **"Log
  Premium"**.
- Alerte Telegram séparée dès qu'une cabine (éco premium, affaires ou
  première) bat son record précédent, avec un rappel qu'il faut revérifier
  le prix avant de réserver.
- Pas encore pilotable par commande Telegram — les réglages
  (`PREMIUM_ENABLED`, `PREMIUM_CABINS`, `PREMIUM_MAX_ORIGINS`, dates) se
  changent directement dans `CONFIG_STATIC`, pas besoin de relancer `setup`
  pour qu'ils prennent effet (relus à chaque passage), sauf pour activer ou
  désactiver le trigger lui-même — dans ce cas relance `setup`.

## Pour arrêter ou ajuster

- `/pause` sur Telegram suspend les deux modules (éco et premium) sans tout
  démonter ; `/demarrer` ou `/reprendre` relance.
- Pour arrêter complètement (supprimer les triggers) : exécute la fonction
  **stop** dans l'éditeur Apps Script.
- Destinations, départs, devises et seuil se pilotent par Telegram. Seuls le
  mois surveillé (`DEPARTURE_MONTH`/`RETURN_MONTH`) et la durée de séjour
  min/max restent dans `CONFIG_STATIC` — modifie-les directement dans le
  code et sauvegarde, ils sont relus à chaque vérification.
