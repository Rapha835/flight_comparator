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
5. Dans ton navigateur, ouvre :
   `https://api.telegram.org/bot<TON_TOKEN>/getUpdates`
   Cherche `"chat":{"id":123456789` dans la réponse → c'est ton **chat_id**.

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
   - Laisse `WEB_APP_URL` tel quel pour l'instant, on le remplit à l'étape 5.
4. Renomme le projet (en haut à gauche) en quelque chose comme
   "Suivi vols Corée".
5. Dans la barre d'outils, sélectionne la fonction **setup** puis clique
   **Exécuter** (▶). Google va demander d'autoriser le script (accès à
   Google Sheets, Drive, et aux requêtes externes) — accepte.

À ce stade, la surveillance automatique tourne déjà toutes les 30 minutes.
Il reste une étape pour piloter tout ça depuis Telegram.

## Étape 4 — Déployer en Web App (pour activer les commandes Telegram)

1. Dans l'éditeur Apps Script, clique **Déployer** (haut à droite) → **Nouveau
   déploiement**.
2. Type de déploiement : **Application Web**.
3. Réglages :
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
   *(cette URL n'est utile qu'à Telegram — le script vérifie ton `chat_id` à
   chaque commande, donc même si quelqu'un la devine, il ne peut rien changer.)*
4. Clique **Déployer**, autorise si demandé, puis copie l'URL générée
   (elle se termine par `/exec`).
5. Retourne dans le code, colle cette URL dans `CONFIG_STATIC.WEB_APP_URL`,
   sauvegarde.
6. Sélectionne la fonction **registerWebhook** dans la barre d'outils, clique
   **Exécuter**. Regarde les logs (Affichage → Journaux) : tu dois voir
   `"ok":true`.

C'est tout : envoie `/aide` à ton bot Telegram pour vérifier que ça répond.

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

## Mettre à jour le script (à lire absolument)

Le déploiement Web App **fige le code au moment du déploiement** : modifier
le code dans l'éditeur ne suffit PAS pour les commandes Telegram. Après
chaque changement :

1. **Déployer → Gérer les déploiements → ✏️ (modifier) → Version :
   « Nouvelle version » → Déployer.**
2. L'URL `/exec` ne change pas — inutile de relancer `registerWebhook`.
3. Envoie `/aide` au bot : la version affichée doit correspondre à
   `SCRIPT_VERSION` en haut du code.

C'est la cause n°1 de « commandes qui ne répondent pas ou appliquent
l'ancien comportement ».

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
  code si besoin, ils sont relus à chaque vérification (mais pense à publier
  une **nouvelle version** du déploiement, voir section ci-dessus).
