/**
 * FLIGHT PRICE WATCH v2.6 — multi-destinations, multi-devises, fenêtres de
 * dates façon FlightList, onboarding guidé par questions dans Telegram.
 *
 * Surveille les prix de vols vers PLUSIEURS destinations en parallèle, dans
 * PLUSIEURS devises (utile pour repérer les erreurs de prix visibles dans une
 * seule devise), depuis une "zone de départ" multi-aéroports (un code pays
 * comme "FR" s'étend automatiquement vers ses principaux aéroports).
 *
 * Critères pilotables par Telegram (assistant /config, 8 questions) :
 *   destinations · zone de départ · fenêtre de dates ALLER (ex. 1–14 oct) ·
 *   fenêtre de dates RETOUR (ex. 19 oct–3 nov) · durée du séjour (nuits) ·
 *   type de billet (éco / éco premium / affaires / first) · escales max ·
 *   budget max (avec repère : meilleur prix et moyenne constatés)
 *
 * L'éco est suivie toutes les 30 min via l'API Travelpayouts ; les cabines
 * avant (éco premium, affaires, première) en veille ~toutes les 4 h + /premium
 * à la demande, via l'API Duffel (vraies offres live, toutes cabines).
 *
 * Alertes Telegram uniquement quand :
 *   - un prix bat son record historique (par destination + devise), ou
 *   - un prix est anormalement bas vs la moyenne relevée (seuil DYNAMIQUE :
 *     /seuil 40 = alerte si prix 40% sous la médiane → probable erreur de prix)
 *   — et jamais deux fois pour le même prix.
 *
 * Tourne 100% côté serveur Google (Apps Script), gratuit, rien à héberger.
 *
 * RÉCEPTION DES COMMANDES TELEGRAM — par POLLING, pas par webhook : le
 * script interroge lui-même l'API Telegram (getUpdates) toutes les minutes.
 * Pourquoi pas un webhook ? Apps Script répond aux requêtes web par une
 * redirection HTTP 302 (comportement Google non contournable), que Telegram
 * considère comme un échec ("Wrong response from the webhook: 302 Found").
 * Le polling est fiable, et supprime tout besoin de déployer en Web App —
 * les triggers exécutent TOUJOURS la dernière version enregistrée du code.
 * Seule contrepartie : le bot répond en 1 minute maxi au lieu d'instantanément.
 *
 * Source de données : Travelpayouts / Aviasales Data API (gratuite, cache
 * jusqu'à ~48h basé sur les recherches réelles des utilisateurs Aviasales).
 * L'API ne connaît ni les bagages, ni l'heure de départ, ni la durée de vol
 * maxi — ces filtres FlightList-là ne sont pas reproductibles gratuitement.
 * => Toujours revérifier le prix exact avant d'acheter.
 *
 * IMPORTANT — codes pays : testé en direct, un code pays sur cette API ne
 * renvoie PAS les prix de tous les aéroports du pays (ex: DE → seulement
 * Francfort). Le script étend donc lui-même chaque code pays via
 * COUNTRY_AIRPORTS ci-dessous.
 *
 * MODULE COMPLÉMENTAIRE — cabines premium (éco premium / affaires / première) :
 * API Duffel (offres live, toutes cabines), veille ~4 h + à la demande via
 * /premium, entièrement isolé par try/catch. Si l'API échoue, le suivi éco
 * continue normalement. (Historique des sources abandonnées pour les cabines
 * avant : scraping Google Flights bloqué anti-bot ; Amadeus self-service
 * fermé le 17/07/2026 ; Travelpayouts = économie uniquement — voir v2.9.)
 */

const SCRIPT_VERSION = "2.10";

/************ CONFIGURATION STATIQUE — à personnaliser une fois ************/
const CONFIG_STATIC = {
  TRAVELPAYOUTS_TOKEN: "COLLE_TON_TOKEN_TRAVELPAYOUTS_ICI",
  TELEGRAM_BOT_TOKEN: "COLLE_TON_TOKEN_TELEGRAM_ICI",
  TELEGRAM_CHAT_ID: "COLLE_TON_CHAT_ID_ICI",

  // --- API Duffel (cabines avant : éco premium / affaires / première) ---
  // Crée un compte sur duffel.com. Le mode TEST renvoie des données FICTIVES
  // (compagnie « Duffel Airways ») : passe ton compte en LIVE et colle ici le
  // jeton d'accès LIVE (commence par « duffel_live_… ») pour de vrais prix.
  DUFFEL_TOKEN: "COLLE_TON_JETON_DUFFEL_LIVE_ICI",

  // Nom du fichier Google Sheet dans ton Drive (réutilisé s'il existe déjà).
  SHEET_NAME: "Historique prix vols",

  // Valeurs de DÉPART au tout premier lancement — l'assistant /config posé à
  // l'installation permet de tout régler depuis Telegram, ces valeurs ne
  // servent que de point de départ et de valeurs "passer".
  DEFAULT_DESTINATIONS: ["SEL"], // "SEL" = Incheon (ICN) + Gimpo (GMP)
  DEFAULT_ORIGINS: ["FR", "BE", "NL", "GB", "DE", "ES", "IT", "PT", "CH"],
  DEFAULT_CURRENCIES: ["EUR", "USD"], // la 1ère est la devise "principale"
  DEFAULT_DEPART_WINDOW: ["2026-10-01", "2026-10-31"], // fenêtre de départ
  DEFAULT_RETURN_WINDOW: ["2026-10-08", "2026-11-21"], // fenêtre de retour
  DEFAULT_STAY: [7, 21],   // durée de séjour min/max (nuits)
  DEFAULT_ALERT_PCT: 40,   // alerte si prix 40% sous la médiane relevée

  // Détection d'anomalie : il faut au moins ANOMALY_MIN_SAMPLES relevés
  // pour calculer une médiane fiable, sur une fenêtre de RECENT_WINDOW relevés.
  ANOMALY_MIN_SAMPLES: 10,
  RECENT_WINDOW: 30,

  // Requêtes API envoyées en parallèle par lots (rapide sans matraquer l'API).
  FETCH_BATCH_SIZE: 15,

  // Devises secondaires : interrogées uniquement pour les N origines les
  // moins chères de chaque destination (gros gain de quota, même résultat).
  SECONDARY_TOP_ORIGINS: 5,
  // Au-delà de ~ce volume de requêtes par vérification, la cadence passe
  // automatiquement à 1x/heure pour rester dans les quotas gratuits Google
  // (~20 000 requêtes/jour). Affiché dans /liste.
  LARGE_CONFIG_REQUESTS: 450,

  // --- Module cabines avant (éco premium / affaires / first) ---
  // Les cabines suivies se choisissent dans l'onboarding ou via /cabines.
  PREMIUM_ENABLED: true, // false = ne crée jamais le trigger quotidien
  PREMIUM_MAX_ORIGINS: 5,  // villes de départ interrogées par cabine
  // Duffel interroge les compagnies en direct (~10-15 s/route). On plafonne le
  // nombre de recherches ET le temps total pour rester sous la limite Apps
  // Script (6 min) : au-delà, /premium renvoie ce qu'il a déjà trouvé.
  PREMIUM_MAX_REQUESTS: 18,
  // La veille en fond interroge moins de hubs que /premium (les grands hubs
  // suffisent pour l'affaires) → moins d'appels Duffel, quota Apps Script tenu.
  PREMIUM_SWEEP_MAX_ORIGINS: 3,
  PREMIUM_TIME_BUDGET_MS: 270000, // 4 min 30 par morceau de balayage
  // Veille préventive : intervalle entre deux balayages COMPLETS (défaut ~4 h,
  // soit ~6/jour). Chaque balayage est découpé sur plusieurs passages du
  // trigger sweepPremium (toutes les 30 min) pour ne jamais dépasser 6 min.
  // ⚠️ Apps Script gratuit = ~90 min/jour de triggers cumulés : si le bot
  // ralentit, augmente cette valeur ou baisse PREMIUM_MAX_ORIGINS.
  PREMIUM_SWEEP_INTERVAL_MS: 14400000 // 4 h
};

// Code pays (ISO 3166-1 alpha-2) → aéroports principaux avec une vraie
// connectivité internationale. Les petits aéroports régionaux sans lien
// long-courrier sont volontairement exclus : ils transitent de toute façon
// par l'un de ces hubs pour rejoindre l'Asie.
const COUNTRY_AIRPORTS = {
  AT: ["VIE"],
  BE: ["BRU", "CRL"],
  BG: ["SOF"],
  CH: ["ZRH", "GVA", "BSL"],
  CY: ["LCA"],
  CZ: ["PRG"],
  DE: ["FRA", "MUC", "BER", "DUS", "HAM"],
  DK: ["CPH"],
  EE: ["TLL"],
  ES: ["MAD", "BCN", "AGP", "VLC"],
  FI: ["HEL"],
  FR: ["PAR", "NCE", "LYS", "MRS", "TLS"],
  GB: ["LON", "MAN", "EDI"],
  GR: ["ATH"],
  HR: ["ZAG", "SPU"],
  HU: ["BUD"],
  IE: ["DUB"],
  IS: ["KEF"],
  IT: ["ROM", "MIL", "VCE", "NAP"],
  LT: ["VNO"],
  LU: ["LUX"],
  LV: ["RIX"],
  MT: ["MLA"],
  NL: ["AMS"],
  NO: ["OSL", "BGO"],
  PL: ["WAW", "KRK", "GDN"],
  PT: ["LIS", "OPO"],
  RO: ["OTP"],
  RS: ["BEG"],
  SE: ["STO"],
  SI: ["LJU"],
  SK: ["BTS"],
  TR: ["IST", "SAW"]
};
/***********************************************************/

/**
 * À exécuter UNE SEULE FOIS manuellement depuis l'éditeur Apps Script
 * (ré-exécutable sans risque : ne perd ni la config ni l'historique).
 * Installe les triggers (commandes Telegram toutes les minutes, prix toutes
 * les 30 min), puis lance l'assistant de configuration dans Telegram.
 */
function setup() {
  getOrCreateSheet_();
  getConfig_(); // initialise (ou migre) la config si besoin

  // Un webhook actif bloque getUpdates (erreur 409) : on le supprime, et on
  // purge au passage les vieux messages accumulés pendant qu'il était cassé.
  const resp = UrlFetchApp.fetch("https://api.telegram.org/bot" + CONFIG_STATIC.TELEGRAM_BOT_TOKEN +
    "/deleteWebhook?drop_pending_updates=true", { muteHttpExceptions: true });
  Logger.log("deleteWebhook : " + resp.getContentText());
  props_().deleteProperty("TG_OFFSET"); // repart de zéro côté messages

  // Supprime TOUS les triggers du projet, y compris ceux laissés par
  // d'anciennes versions du script, qui planteraient en boucle si leur
  // fonction n'existe plus.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("pollTelegram").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("checkPrices").timeBased().everyMinutes(30).create();

  if (CONFIG_STATIC.PREMIUM_ENABLED) {
    // Veille préventive des cabines avant : le balayage complet est découpé sur
    // plusieurs passages de ce trigger (voir sweepPremium / PREMIUM_SWEEP_*).
    ScriptApp.newTrigger("sweepPremium").timeBased().everyMinutes(30).create();
    props_().deleteProperty("PREMIUM_SWEEP"); // repart d'un balayage propre
  }

  replyTelegram_("🤖 Flight Price Watch v" + SCRIPT_VERSION + " installé !\n" +
    "Configurons ta recherche en 8 questions rapides. Réponds simplement ; " +
    "envoie « passer » pour garder la valeur proposée, /annuler pour tout garder par défaut. " +
    "(Je réponds en 1 min maxi.)");
  startWizard_();
  Logger.log("Setup v" + SCRIPT_VERSION + " terminé.");
}

/** Arrête toutes les vérifications automatiques (supprime tous les triggers). */
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  Logger.log("Surveillance arrêtée (triggers supprimés).");
}

/**
 * Relève les messages Telegram (trigger toutes les minutes) via getUpdates.
 * L'offset (TG_OFFSET) est avancé AVANT de traiter chaque message : si une
 * commande plante, elle n'est pas rejouée en boucle au passage suivant.
 */
function pollTelegram() {
  try {
    const offset = Number(props_().getProperty("TG_OFFSET") || 0);
    const url = "https://api.telegram.org/bot" + CONFIG_STATIC.TELEGRAM_BOT_TOKEN +
      "/getUpdates?timeout=0" + (offset ? "&offset=" + offset : "");
    const json = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
    if (!json.ok) {
      // Erreur 409 = un webhook est encore actif et bloque getUpdates —
      // ré-exécute setup() pour le supprimer.
      Logger.log("Erreur getUpdates : " + JSON.stringify(json));
      return;
    }

    json.result.forEach(function (update) {
      props_().setProperty("TG_OFFSET", String(update.update_id + 1));
      const message = update.message;
      if (!message || !message.text) return;
      const chatId = String(message.chat.id);
      if (chatId === String(CONFIG_STATIC.TELEGRAM_CHAT_ID)) {
        handleCommand_(message.text.trim());
      } else {
        // Seul ton chat peut piloter le bot — mais on journalise l'id reçu :
        // c'est LE réflexe de debug si le bot ne répond pas (panneau
        // Exécutions > clique sur un pollTelegram > Journaux Cloud).
        Logger.log("Message ignoré — chat_id reçu : " + chatId +
          " ≠ attendu : " + CONFIG_STATIC.TELEGRAM_CHAT_ID);
      }
    });
  } catch (err) {
    Logger.log("Erreur pollTelegram: " + err);
  }
}

function handleCommand_(text) {
  const parts = text.split(/\s+/);
  // Telegram ajoute parfois "@nomdubot" à la commande (ex: "/aide@mon_bot")
  // quand elle est tapée depuis la liste de suggestions — on l'ignore.
  const cmd = parts[0].toLowerCase().split("@")[0];
  const arg = parts.slice(1).join(" ").trim();

  // Texte sans "/" : réponse à l'assistant s'il est en cours, sinon un code
  // aéroport seul (ex. "ICN") = raccourci pour /demarrer ICN.
  if (cmd.charAt(0) !== "/") {
    if (getJson_("WIZARD", null)) { wizardAnswer_(text); return; }
    if (/^[a-z]{3}$/.test(cmd) && !arg) { cmdDemarrer_(cmd.toUpperCase()); return; }
    replyTelegram_("🤔 Pas compris. Envoie un code aéroport (ex. ICN), /config pour l'assistant, ou /aide.");
    return;
  }

  // Toute commande / interrompt l'assistant en cours (sauf /annuler qui le
  // fait proprement).
  if (getJson_("WIZARD", null) && cmd !== "/annuler") props_().deleteProperty("WIZARD");

  const cfg = getConfig_();

  if (cmd === "/config") {
    startWizard_();

  } else if (cmd === "/annuler") {
    props_().deleteProperty("WIZARD");
    replyTelegram_("👌 Assistant annulé — la config actuelle reste en place (/liste pour la voir).");

  } else if (cmd === "/demarrer" || cmd === "/reprendre") {
    cmdDemarrer_(arg ? arg.toUpperCase() : null);

  } else if (cmd === "/pause") {
    cfg.paused = true;
    saveConfig_(cfg);
    replyTelegram_("⏸️ Surveillance en pause. /demarrer pour relancer.");

  } else if (cmd === "/seuil") {
    const val = parseInt(arg, 10);
    if (isNaN(val) || val < 5 || val > 90) {
      replyTelegram_("Utilise : /seuil 40 → alerte si un prix tombe 40% sous la moyenne relevée.");
      return;
    }
    cfg.alertPct = val;
    saveConfig_(cfg);
    replyTelegram_("🚨 OK : alerte si un prix tombe " + val + "% sous la moyenne (+ records battus).");

  } else if (cmd === "/dates") {
    const w = parseWindow_(arg);
    if (!w) { replyTelegram_("Fenêtre de DÉPART. Ex : /dates 2026-10 (tout le mois) ou /dates 2026-10-01 2026-10-14"); return; }
    cfg.departWindow = w;
    saveConfig_(cfg);
    replyTelegram_("📅 Départ entre " + w[0] + " et " + w[1] + ". (Fenêtre de retour : /retour · vérifier : /check)");

  } else if (cmd === "/retour") {
    const w = parseWindow_(arg);
    if (!w) { replyTelegram_("Fenêtre de RETOUR. Ex : /retour 2026-11 ou /retour 2026-10-19 2026-11-03"); return; }
    cfg.returnWindow = w;
    saveConfig_(cfg);
    replyTelegram_("📅 Retour entre " + w[0] + " et " + w[1] + ". (/check pour vérifier tout de suite)");

  } else if (cmd === "/duree") {
    const stay = parseStay_(arg);
    if (!stay) { replyTelegram_("Utilise : /duree 14 21 → séjour entre 14 et 21 nuits."); return; }
    cfg.stayMin = stay[0];
    cfg.stayMax = stay[1];
    saveConfig_(cfg);
    replyTelegram_("🌙 OK : séjour entre " + stay[0] + " et " + stay[1] + " nuits.");

  } else if (cmd === "/cabines") {
    const cabins = arg ? parseCabins_(arg) : null;
    if (!cabins) { replyTelegram_("Utilise : /cabines eco affaires (choix : eco, eco premium, affaires, first, toutes)."); return; }
    cfg.cabins = cabins;
    saveConfig_(cfg);
    replyTelegram_("✈️ Billets suivis : " + cabins.map(cabinLabel_).join(", ") + "." +
      (cabins.indexOf("economy") === -1 ? "\n⚠️ Éco non suivie : les vérifications 30 min sont suspendues, cabines avant en veille ~4 h + /premium." : ""));

  } else if (cmd === "/escales") {
    const t = parseTransfers_(arg);
    if (t === undefined) { replyTelegram_("Utilise : /escales 0 (direct), 1, 2, ou /escales non (peu importe)."); return; }
    cfg.maxTransfers = t;
    saveConfig_(cfg);
    replyTelegram_(t === null ? "🔁 OK : nombre d'escales libre." : "🔁 OK : " + t + " escale(s) maxi par trajet.");

  } else if (cmd === "/budget") {
    // "/budget 700" = éco ; "/budget affaires 2500" = par cabine.
    const cabins = parseCabins_(arg) || ["economy"];
    const b = /\b(non|aucun)\b/i.test(arg) ? null : parseBudget_(arg);
    if (b === undefined) { replyTelegram_("Utilise : /budget 700 (éco), /budget affaires 2500, ou /budget non."); return; }
    cabins.forEach(function (c) { cfg.budgets[c] = b; });
    saveConfig_(cfg);
    replyTelegram_(b === null ? "💰 OK : pas de budget " + cabins.map(cabinLabel_).join("/") + "."
      : "💰 OK : budget " + cabins.map(cabinLabel_).join("/") + " ≤ " + b + " " + cfg.currencies[0] + ".");

  } else if (cmd === "/ajouter") {
    if (!arg) { replyTelegram_("Utilise : /ajouter FR (pays) ou /ajouter CDG (aéroport de départ)."); return; }
    const codeAdd = arg.toUpperCase();
    if (cfg.origins.indexOf(codeAdd) === -1) cfg.origins.push(codeAdd);
    saveConfig_(cfg);
    replyTelegram_("🛫 Départ ajouté : " + codeAdd + " (" + expandOrigins_(cfg.origins).length + " aéroports surveillés)");

  } else if (cmd === "/retirer") {
    if (!arg) { replyTelegram_("Utilise : /retirer ICN (destination) ou /retirer FR (départ)."); return; }
    const codeRemove = arg.toUpperCase();
    if (cfg.destinations.indexOf(codeRemove) !== -1) {
      if (cfg.destinations.length === 1) { replyTelegram_("⚠️ Il faut garder au moins une destination."); return; }
      cfg.destinations = cfg.destinations.filter(function (d) { return d !== codeRemove; });
      saveConfig_(cfg);
      replyTelegram_("🗑️ Destination retirée : " + codeRemove + ". Reste : " + cfg.destinations.join(", "));
    } else if (cfg.origins.indexOf(codeRemove) !== -1) {
      cfg.origins = cfg.origins.filter(function (o) { return o !== codeRemove; });
      saveConfig_(cfg);
      replyTelegram_("🗑️ Départ retiré : " + codeRemove + " (" + expandOrigins_(cfg.origins).length + " aéroports surveillés)");
    } else {
      replyTelegram_("⚠️ " + codeRemove + " n'est ni dans les destinations (" + cfg.destinations.join(", ") + ") ni dans les départs.");
    }

  } else if (cmd === "/devises") {
    const curs = arg.toUpperCase().split(/[\s,]+/).filter(function (c) { return /^[A-Z]{3}$/.test(c); });
    if (curs.length === 0) { replyTelegram_("Utilise : /devises EUR USD"); return; }
    cfg.currencies = curs;
    saveConfig_(cfg);
    replyTelegram_("💱 Devises suivies : " + curs.join(", "));

  } else if (cmd === "/liste") {
    replyTelegram_(listText_(cfg));

  } else if (cmd === "/status") {
    replyTelegram_(buildStatusText_(cfg));

  } else if (cmd === "/check") {
    replyTelegram_("🔍 Je vérifie " + cfg.destinations.join(" + ") + "… (" + etaText_(cfg, cfg.destinations.length) + ")");
    runCheck_(cfg, cfg.destinations, true);

  } else if (cmd === "/premium") {
    replyTelegram_("🥂 Je vérifie éco premium / affaires / première… (1 à 2 min)");
    runPremiumCheck_(true);

  } else if (cmd === "/aide" || cmd === "/help" || cmd === "/start") {
    replyTelegram_(helpText_());

  } else {
    replyTelegram_("🤔 Commande inconnue. Envoie /aide.");
  }
}

/** /demarrer [DEST] : réactive la surveillance, et si DEST est fourni,
 * l'ajoute aux destinations suivies puis lance un check immédiat dessus. */
function cmdDemarrer_(dest) {
  const cfg = getConfig_();
  const wasPaused = cfg.paused;
  cfg.paused = false;
  let isNew = false;
  if (dest && cfg.destinations.indexOf(dest) === -1) {
    cfg.destinations.push(dest);
    isNew = true;
  }
  saveConfig_(cfg);

  if (dest) {
    replyTelegram_((isNew ? "🎯 " + dest + " ajoutée !" : "🎯 " + dest + " déjà suivie.") +
      (wasPaused ? " Surveillance réactivée." : "") + " Je vérifie… (" + etaText_(cfg, 1) + ")");
    runCheck_(cfg, [dest], true);
  } else {
    replyTelegram_(wasPaused ? "▶️ Surveillance réactivée." : "▶️ Surveillance déjà active.");
  }
}

/** ============ ASSISTANT DE CONFIGURATION (/config) ============
 * 8 questions posées une par une dans Telegram, calquées sur les critères
 * FlightList. "passer" garde la valeur actuelle, /annuler abandonne.
 * L'état (numéro d'étape) vit dans la propriété WIZARD. */
const WIZARD_STEPS_ = ["destinations", "origins", "depart", "retour", "duree", "cabines", "escales", "budget"];

function startWizard_() {
  setJson_("WIZARD", { step: 0, cabinIdx: 0 });
  replyTelegram_(wizardQuestion_(0, getConfig_(), 0));
}

function wizardQuestion_(step, cfg, cabinIdx) {
  const n = (step + 1) + "/" + WIZARD_STEPS_.length + " — ";
  switch (WIZARD_STEPS_[step]) {
    case "destinations":
      return "🎯 " + n + "Destination(s) ?\nEx : ICN, ou plusieurs : ICN GMP NRT\n(actuel : " + cfg.destinations.join(" ") + ")";
    case "origins":
      return "🛫 " + n + "Zone de départ ? Pays (2 lettres) et/ou aéroports (3 lettres).\nEx : FR BE NL ou CDG AMS BRU\n(actuel : " + cfg.origins.join(" ") + ")";
    case "depart":
      return "📅 " + n + "Fenêtre de DÉPART ?\nEx : 2026-10 (tout le mois) ou 2026-10-01 2026-10-14\n(actuel : " + cfg.departWindow[0] + " → " + cfg.departWindow[1] + ")";
    case "retour":
      return "📅 " + n + "Fenêtre de RETOUR ?\nEx : 2026-11 ou 2026-10-19 2026-11-03\n(actuel : " + cfg.returnWindow[0] + " → " + cfg.returnWindow[1] + ")";
    case "duree":
      return "🌙 " + n + "Durée du séjour, en nuits ?\nEx : 14 21 (entre 14 et 21 nuits)\n(actuel : " + cfg.stayMin + "–" + cfg.stayMax + ")";
    case "cabines":
      return "✈️ " + n + "Type de billet ? Plusieurs possibles.\nEx : eco · eco premium · affaires · first · toutes\n(actuel : " + cfg.cabins.map(cabinLabel_).join(", ") + ")\n" +
        "ℹ️ L'éco est vérifiée toutes les 30 min ; les cabines avant en veille ~4 h (alerte sous ta cible) + /premium.";
    case "escales":
      return "🔁 " + n + "Escales maxi par trajet ?\nEx : 0 (direct), 1, 2, ou « non » (peu importe)\n(actuel : " + (cfg.maxTransfers === null ? "peu importe" : cfg.maxTransfers) + ")";
    case "budget": {
      // Une question par type de billet choisi, chacune avec son repère.
      const cabin = cfg.cabins[cabinIdx || 0];
      const current = budgetFor_(cfg, cabin);
      return "💰 " + n + "Budget maxi " + cabinLabel_(cabin).toUpperCase() + ", en " + cfg.currencies[0] + " ?\nEx : 700, ou « non »\n(actuel : " + (current === null ? "aucun" : current) + ")" + priceHint_(cfg, cabin);
    }
  }
}

/** Repère de prix affiché avec la question budget : historique récent si
 * disponible, sinon sondage express de quelques aéroports (~2 s). */
function priceHint_(cfg, cabin) {
  try {
    const cur = cfg.currencies[0];

    // Cabines avant : dernier relevé premium si dispo (toutes destinations),
    // sinon on invite à /premium (pas de sondage live : Duffel est trop lent
    // pour bloquer l'assistant pendant une question).
    if (cabin && cabin !== "economy") {
      const prem = getJson_("LAST_PREMIUM", null);
      for (let i = 0; i < cfg.destinations.length; i++) {
        const d = cfg.destinations[i];
        if (prem && prem.results && prem.results[cabin + "|" + d]) {
          const known = prem.results[cabin + "|" + d];
          return "\n📊 Repère " + cabinLabel_(cabin) + " " + d + " : " + known.price + " " + known.currency + " (" + known.origin + ")";
        }
      }
      return "\n(pas de repère dispo pour cette cabine — essaie /premium après la config)";
    }

    // Éco — sources par ordre de fraîcheur/fiabilité :
    // 1) historique accumulé par le tracker (première destination qui en a)
    const recent = getJson_("RECENT", {});
    for (let i = 0; i < cfg.destinations.length; i++) {
      const d = cfg.destinations[i];
      const hist = recent[d + "|" + cur];
      if (hist && hist.length >= 3) {
        return "\n📊 Repère " + d + " : meilleur récent " + Math.min.apply(null, hist) + " " + cur +
          ", moyenne ~" + Math.round(median_(hist)) + " " + cur;
      }
    }

    // 2) dernière vérification complète
    const lastResult = getJson_("LAST_RESULT", null);
    if (lastResult && lastResult.results) {
      for (let i = 0; i < cfg.destinations.length; i++) {
        const d = cfg.destinations[i];
        const r = lastResult.results[d + "|" + cur];
        if (r && r.best) {
          return "\n📊 Repère " + d + " : meilleur actuel " + r.best.price + " " + cur + " (" + r.best.origin + ")";
        }
      }
    }

    // 3) sondage express : 6 origines × les 2 premières destinations
    const origins = expandOrigins_(cfg.origins).slice(0, 6);
    const dm = monthsInWindow_(cfg.departWindow)[0];
    const months = monthsInWindow_(cfg.returnWindow);
    const rm = months[months.length - 1] < dm ? dm : months[months.length - 1];
    const probes = [];
    cfg.destinations.slice(0, 2).forEach(function (d) {
      origins.forEach(function (o) {
        probes.push({ dest: d, url: buildApiUrl_(o, d, cur, dm, rm) });
      });
    });
    const resps = UrlFetchApp.fetchAll(probes.map(function (pr) { return { url: pr.url, muteHttpExceptions: true }; }));
    const byDest = {};
    resps.forEach(function (r, i) {
      try {
        const offers = parseOffers_(r, cfg, cur);
        if (offers.length > 0) {
          if (!byDest[probes[i].dest]) byDest[probes[i].dest] = [];
          byDest[probes[i].dest].push(offers[0].price);
        }
      } catch (e) { /* route sans donnée : ignorée */ }
    });
    const lines = [];
    Object.keys(byDest).forEach(function (d) {
      const arr = byDest[d];
      lines.push("📊 Repère " + d + " : meilleur constaté " + Math.min.apply(null, arr) + " " + cur +
        ", moyenne ~" + Math.round(median_(arr)) + " " + cur);
    });
    if (lines.length > 0) return "\n" + lines.join("\n");

    // 4) vraiment aucune donnée : on le DIT, jamais de silence.
    return "\n(pas encore de repère : le cache API n'a pas de prix pour ces routes — il se remplira dès les premières vérifications, regarde /status ensuite)";
  } catch (e) {
    Logger.log("priceHint_ : " + e);
    return "\n(repère indisponible pour l'instant)";
  }
}

function wizardAnswer_(text) {
  const wiz = getJson_("WIZARD", null);
  if (!wiz) return;
  const cfg = getConfig_();
  const t = text.trim();
  const stepName = WIZARD_STEPS_[wiz.step];

  if (!/^(passer|skip|ok)$/i.test(t)) {
    let parsed = null;
    switch (stepName) {
      case "destinations": {
        const codes = parseCodes_(t, 3);
        if (codes) { cfg.destinations = codes; parsed = true; }
        break;
      }
      case "origins": {
        const codes = parseCodes_(t, null);
        if (codes) { cfg.origins = codes; parsed = true; }
        break;
      }
      case "depart": {
        const w = parseWindow_(t);
        if (w) { cfg.departWindow = w; parsed = true; }
        break;
      }
      case "retour": {
        const w = parseWindow_(t);
        if (w) { cfg.returnWindow = w; parsed = true; }
        break;
      }
      case "duree": {
        const stay = parseStay_(t);
        if (stay) { cfg.stayMin = stay[0]; cfg.stayMax = stay[1]; parsed = true; }
        break;
      }
      case "cabines": {
        const cabins = parseCabins_(t);
        if (cabins) { cfg.cabins = cabins; parsed = true; }
        break;
      }
      case "escales": {
        const tr = parseTransfers_(t);
        if (tr !== undefined) { cfg.maxTransfers = tr; parsed = true; }
        break;
      }
      case "budget": {
        const b = parseBudget_(t);
        if (b !== undefined) { cfg.budgets[cfg.cabins[wiz.cabinIdx || 0]] = b; parsed = true; }
        break;
      }
    }
    if (!parsed) {
      replyTelegram_("🤔 Format non reconnu, réessaie (ou « passer »).\n\n" + wizardQuestion_(wiz.step, cfg, wiz.cabinIdx || 0));
      return;
    }
    saveConfig_(cfg);
  }

  // L'étape budget se répète pour chaque type de billet choisi.
  if (stepName === "budget" && (wiz.cabinIdx || 0) + 1 < cfg.cabins.length) {
    const nextIdx = (wiz.cabinIdx || 0) + 1;
    setJson_("WIZARD", { step: wiz.step, cabinIdx: nextIdx });
    replyTelegram_("✅ Noté !\n\n" + wizardQuestion_(wiz.step, cfg, nextIdx));
    return;
  }

  const next = wiz.step + 1;
  if (next < WIZARD_STEPS_.length) {
    setJson_("WIZARD", { step: next, cabinIdx: 0 });
    replyTelegram_("✅ Noté !\n\n" + wizardQuestion_(next, cfg, 0));
  } else {
    props_().deleteProperty("WIZARD");
    replyTelegram_("🎉 Configuration terminée !\n\n" + listText_(cfg) + "\n\n🔍 Première vérification… (" + etaText_(cfg, cfg.destinations.length) + ")");
    runCheck_(cfg, cfg.destinations, true);
  }
}

/** ---- Parseurs partagés assistant/commandes ---- */
// Liste de codes IATA. len=3 → uniquement des codes 3 lettres ; len=null →
// mélange 2 (pays) / 3 (aéroport) lettres accepté.
function parseCodes_(text, len) {
  const raw = text.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  if (raw.length === 0) return null;
  const re = len === 3 ? /^[A-Z]{3}$/ : /^[A-Z]{2,3}$/;
  for (let i = 0; i < raw.length; i++) if (!re.test(raw[i])) return null;
  return raw.filter(function (c, i) { return raw.indexOf(c) === i; });
}

// "2026-10" → tout le mois ; "2026-10-01 2026-10-14" → fenêtre précise.
// Retourne [from, to] (YYYY-MM-DD) ou null.
function parseWindow_(text) {
  const t = text.trim();
  let m = t.match(/^(\d{4})-(\d{2})$/);
  if (m) return [t + "-01", t + "-" + lastDayOfMonth_(+m[1], +m[2])];
  m = t.match(/^(\d{4}-\d{2}-\d{2})[\s,à→-]+(\d{4}-\d{2}-\d{2})$/);
  if (m && m[1] <= m[2]) return [m[1], m[2]];
  m = t.match(/^(\d{4}-\d{2}-\d{2})$/); // une seule date = fenêtre d'un jour
  if (m) return [m[1], m[1]];
  return null;
}

function lastDayOfMonth_(y, mo) {
  const d = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d < 10 ? "0" + d : String(d);
}

function parseStay_(text) {
  const nums = text.split(/[\s,à-]+/).map(function (n) { return parseInt(n, 10); }).filter(function (n) { return !isNaN(n) && n > 0; });
  if (nums.length === 1) return [nums[0], nums[0]];
  if (nums.length === 2 && nums[0] <= nums[1]) return nums;
  return null;
}

// "eco affaires" → ["economy","business"] ; "toutes" → les 4 cabines ;
// null si rien de reconnu. Gère "eco premium" (2 mots) avant "eco".
function parseCabins_(text) {
  let t = " " + text.toLowerCase().replace(/[éè]/g, "e") + " ";
  if (/^\s*(toutes|tout|all)\s*$/.test(t)) {
    return ["economy", "premium-economy", "business", "first"];
  }
  const out = [];
  const found = [
    [/eco(nomy)?\s*premium|premium\s*eco(nomy)?|premium[- ]?economy|\bpremium\b/, "premium-economy"],
    [/\baffaires?\b|\bbusiness\b|\bbiz\b/, "business"],
    [/\bfirst\b|\bpremiere\b|\b1ere\b/, "first"]
  ];
  found.forEach(function (pair) {
    if (pair[0].test(t)) {
      out.push(pair[1]);
      t = t.replace(pair[0], " ");
    }
  });
  if (/\beco(nomy)?(nomique)?\b/.test(t)) out.unshift("economy");
  return out.length > 0 ? out : null;
}

// Retourne 0/1/2… (max), null ("peu importe"), ou undefined (non reconnu).
function parseTransfers_(text) {
  const t = text.trim().toLowerCase();
  if (/^(non|peu importe|libre|aucune limite|np)$/.test(t)) return null;
  const n = parseInt(t, 10);
  if (!isNaN(n) && n >= 0 && n <= 5) return n;
  return undefined;
}

// Retourne un montant, null ("non"), ou undefined (non reconnu).
function parseBudget_(text) {
  const t = text.trim().toLowerCase();
  if (/^(non|aucun|pas de budget|illimité)$/.test(t)) return null;
  const n = parseInt(t.replace(/[^\d]/g, ""), 10);
  if (!isNaN(n) && n > 0) return n;
  return undefined;
}

function listText_(cfg) {
  const expanded = expandOrigins_(cfg.origins);
  return "⚙️ Config actuelle\n" +
    "🎯 Destinations : " + cfg.destinations.join(", ") + "\n" +
    "🛫 Départs : " + cfg.origins.join(", ") + " (" + expanded.length + " aéroports)\n" +
    "📅 Aller " + fmtWindow_(cfg.departWindow) + " · retour " + fmtWindow_(cfg.returnWindow) + "\n" +
    "✈️ Billets : " + cfg.cabins.map(cabinLabel_).join(", ") + "\n" +
    "🌙 Séjour " + cfg.stayMin + "–" + cfg.stayMax + " nuits · 🔁 " +
    (cfg.maxTransfers === null ? "escales libres" : cfg.maxTransfers + " esc. max") +
    budgetsLabel_(cfg) + "\n" +
    "💱 " + cfg.currencies.join(", ") + "\n" +
    "🚨 Alerte : record battu, ou prix " + cfg.alertPct + "% sous la moyenne\n" +
    (cfg.paused ? "⏸️ En pause" : "▶️ Actif (" + cadenceLabel_(cfg) + ")") + " — v" + SCRIPT_VERSION;
}

function buildStatusText_(cfg) {
  const lastResult = getJson_("LAST_RESULT", null);
  if (!lastResult || !lastResult.results || Object.keys(lastResult.results).length === 0) {
    return "Aucune vérification pour l'instant — envoie /check.";
  }
  const mins = getJson_("MINS", {});
  const lines = ["📊 Derniers prix (" + fmtDateTime_(lastResult.checkedAt) + ")"];

  cfg.destinations.forEach(function (dest) {
    cfg.currencies.forEach(function (cur) {
      const key = dest + "|" + cur;
      const r = lastResult.results[key];
      if (!r) return;
      lines.push("\n🎯 " + dest + " · " + cur + (key in mins ? " (record " + mins[key] + ")" : ""));
      (r.top || [r.best]).slice(0, 3).forEach(function (o, i) {
        lines.push((i + 1) + ". " + o.origin + " " + o.price + " · " + fmtDate_(o.departure_at) + "→" + fmtDate_(o.return_at) +
          " · " + o.transfers + " esc.");
      });
    });
  });

  // Cabines premium (dernier relevé quotidien ou /premium)
  const prem = getJson_("LAST_PREMIUM", null);
  if (prem && prem.results && Object.keys(prem.results).length > 0) {
    lines.push("\n🥂 Cabines (" + fmtDateTime_(prem.checkedAt) + ") :");
    Object.keys(prem.results).sort().forEach(function (k) {
      const p = prem.results[k];
      lines.push(cabinLabel_(p.cabin) + " " + p.destination + " : " + p.price + " " + (p.currency || "") + " (" + p.origin + ", " + p.stops + " esc.)");
    });
  } else if (CONFIG_STATIC.PREMIUM_ENABLED) {
    lines.push("\n🥂 Cabines premium : pas encore de relevé — envoie /premium.");
  }

  return lines.join("\n");
}

function helpText_() {
  return "✈️ Flight Price Watch v" + SCRIPT_VERSION + "\n\n" +
    "⭐ /config — assistant complet (8 questions)\n\n" +
    "🎯 Destinations\n" +
    "ICN — suivre un aéroport (ou /demarrer ICN)\n" +
    "/retirer ICN — ne plus le suivre\n\n" +
    "🛫 Zone de départ\n" +
    "/ajouter FR ou CDG · /retirer CDG\n\n" +
    "📅 Dates (fenêtres façon FlightList)\n" +
    "/dates 2026-10-01 2026-10-14 — fenêtre aller\n" +
    "/retour 2026-10-19 2026-11-03 — fenêtre retour\n" +
    "/duree 14 21 — séjour min/max (nuits)\n\n" +
    "⚙️ Filtres & réglages\n" +
    "/cabines eco affaires — type de billet\n" +
    "/escales 1 · /budget 700 (éco) · /budget affaires 2500\n" +
    "/devises EUR USD\n" +
    "/seuil 40 — alerte si prix 40% sous la moyenne\n" +
    "/pause · /reprendre\n\n" +
    "🔍 Consulter\n" +
    "/check — vérifier maintenant\n" +
    "/premium — prix cabines avant (éco premium / affaires / première)\n" +
    "/status — derniers prix · /liste — config";
}

/** Fonction appelée automatiquement par le trigger toutes les 30 minutes. */
function checkPrices() {
  const cfg = getConfig_();
  if (cfg.paused) {
    Logger.log("Vérification ignorée : en pause.");
    return;
  }
  if (cfg.cabins.indexOf("economy") === -1) {
    Logger.log("Vérification éco ignorée : billets suivis = " + cfg.cabins.join(", ") + " (voir /cabines).");
    return;
  }
  // Config large (beaucoup de destinations × départs) : une vérification sur
  // deux est sautée pour rester dans les quotas gratuits (≈20 000 req/jour).
  if (estimateRequests_(cfg) > CONFIG_STATIC.LARGE_CONFIG_REQUESTS) {
    const tick = props_().getProperty("CHECK_TICK") === "1" ? "0" : "1";
    props_().setProperty("CHECK_TICK", tick);
    if (tick === "0") {
      Logger.log("Config large : vérification sautée (cadence effective 1x/heure).");
      return;
    }
  }
  runCheck_(cfg, cfg.destinations, false);
}

/** Volume approximatif de requêtes API pour une vérification complète. */
function estimateRequests_(cfg) {
  const combos = monthsInWindow_(cfg.departWindow).slice(0, 3).length *
    monthsInWindow_(cfg.returnWindow).slice(0, 3).length;
  return cfg.destinations.length * combos *
    (expandOrigins_(cfg.origins).length + (cfg.currencies.length - 1) * CONFIG_STATIC.SECONDARY_TOP_ORIGINS);
}

function cadenceLabel_(cfg) {
  return estimateRequests_(cfg) > CONFIG_STATIC.LARGE_CONFIG_REQUESTS
    ? "toutes les 60 min — config large" : "toutes les 30 min";
}

/** Durée estimée d'une vérification, pour les messages « Je vérifie… ». */
function etaText_(cfg, destCount) {
  const perDest = estimateRequests_(cfg) / cfg.destinations.length;
  const batches = Math.ceil(perDest * destCount / CONFIG_STATIC.FETCH_BATCH_SIZE);
  const secs = Math.max(10, Math.round(batches * 1.5) + 3);
  return secs > 90 ? "~" + Math.ceil(secs / 60) + " min" : "~" + secs + " s";
}

/**
 * Cœur du tracker : interroge l'API pour chaque origine × destination ×
 * devise × mois des fenêtres (par lots parallèles), filtre selon les
 * critères (fenêtres de dates précises, séjour, escales, budget),
 * journalise dans la Sheet, met à jour les records et envoie les alertes.
 *
 * N'écrit JAMAIS dans CONFIG : un /pause envoyé pendant un check ne peut
 * donc plus être écrasé (bug de la v1).
 *
 * verbose=true (via /check, /demarrer ou l'assistant) : envoie un résumé
 * Telegram des meilleurs prix trouvés, même sans alerte.
 */
function runCheck_(cfg, destinations, verbose) {
  const expanded = expandOrigins_(cfg.origins);
  // L'API raisonne au mois : on interroge chaque combinaison de mois couverte
  // par les fenêtres, puis on filtre finement par date exacte.
  const departMonths = monthsInWindow_(cfg.departWindow).slice(0, 3);
  const returnMonths = monthsInWindow_(cfg.returnWindow).slice(0, 3);
  const mainCur = cfg.currencies[0];
  const buckets = {};

  // Passe 1 : devise principale, toutes les origines.
  const requests = [];
  destinations.forEach(function (dest) {
    expanded.forEach(function (origin) {
      departMonths.forEach(function (dm) {
        returnMonths.forEach(function (rm) {
          if (rm < dm) return;
          requests.push({ origin: origin, dest: dest, cur: mainCur, url: buildApiUrl_(origin, dest, mainCur, dm, rm) });
        });
      });
    });
  });
  collectBest_(requests, cfg, buckets);

  // Passe 2 : devises secondaires, uniquement pour les origines les moins
  // chères de chaque destination — comparer les devises n'a d'intérêt que
  // sur les meilleures routes, et ça divise le volume de requêtes.
  if (cfg.currencies.length > 1) {
    const requests2 = [];
    destinations.forEach(function (dest) {
      const mainList = buckets[dest + "|" + mainCur];
      if (!mainList) return;
      const topOrigins = [];
      mainList.slice().sort(function (a, b) { return a.price - b.price; }).forEach(function (o) {
        if (topOrigins.indexOf(o.origin) === -1 && topOrigins.length < CONFIG_STATIC.SECONDARY_TOP_ORIGINS) {
          topOrigins.push(o.origin);
        }
      });
      cfg.currencies.slice(1).forEach(function (cur) {
        topOrigins.forEach(function (origin) {
          departMonths.forEach(function (dm) {
            returnMonths.forEach(function (rm) {
              if (rm < dm) return;
              requests2.push({ origin: origin, dest: dest, cur: cur, url: buildApiUrl_(origin, dest, cur, dm, rm) });
            });
          });
        });
      });
    });
    collectBest_(requests2, cfg, buckets);
  }

  const keys = Object.keys(buckets);
  if (keys.length === 0) {
    Logger.log("Aucun résultat cette fois-ci.");
    if (verbose) replyTelegram_("😕 Aucun vol trouvé pour " + destinations.join(", ") + " avec ces critères (fenêtres " +
      fmtWindow_(cfg.departWindow) + " → " + fmtWindow_(cfg.returnWindow) +
      ", " + cfg.stayMin + "–" + cfg.stayMax + " nuits" +
      (cfg.maxTransfers !== null ? ", " + cfg.maxTransfers + " esc. max" : "") +
      "). Élargis un critère (/config) ou réessaie plus tard — le cache API se remplit au fil des recherches réelles.");
    return;
  }

  const mins = getJson_("MINS", {});
  const alerted = getJson_("ALERTED", {});
  const recent = getJson_("RECENT", {});
  const lastResult = getJson_("LAST_RESULT", { results: {} });
  if (!lastResult.results) lastResult.results = {};

  const now = new Date();
  const rows = [];
  const summaryLines = [];
  // Relu au dernier moment : si /pause est arrivé pendant les requêtes,
  // on enregistre tout mais on n'alerte pas.
  const pausedNow = !verbose && getConfig_().paused;

  destinations.forEach(function (dest) {
    cfg.currencies.forEach(function (cur) {
      const key = dest + "|" + cur;
      const list = buckets[key];
      if (!list) return;
      list.sort(function (a, b) { return a.price - b.price; });
      const best = list[0];

      // Journalise le top 10 (garde la Sheet légère malgré les multi-fenêtres).
      list.slice(0, 10).forEach(function (o) {
        rows.push([now, o.origin, dest, cur, o.price, o.airline, o.departure_at, o.return_at, o.transfers, buildLink_(o)]);
      });

      const hist = recent[key] || [];
      const med = median_(hist);
      const prevMin = (key in mins) ? mins[key] : null;

      // Jamais d'alerte au tout premier relevé d'un couple destination/devise :
      // on enregistre la référence, les alertes commencent au relevé suivant.
      const isNewLow = prevMin !== null && best.price < prevMin;
      // Seuil dynamique : prix alertPct% sous la médiane des derniers relevés,
      // dédupliqué (pas de re-alerte tant que le prix ne baisse pas encore).
      const isAnomaly = hist.length >= CONFIG_STATIC.ANOMALY_MIN_SAMPLES && med !== null &&
        best.price <= med * (1 - cfg.alertPct / 100) &&
        (!(key in alerted) || best.price < alerted[key]);

      if (prevMin === null || best.price < prevMin) mins[key] = best.price;
      hist.push(best.price);
      if (hist.length > CONFIG_STATIC.RECENT_WINDOW) hist.splice(0, hist.length - CONFIG_STATIC.RECENT_WINDOW);
      recent[key] = hist;

      lastResult.results[key] = { best: best, top: list.slice(0, 5) };

      // Résumé compact : top 3 dans la devise principale, meilleur prix seul
      // dans les autres devises.
      if (cur === cfg.currencies[0]) {
        const ecoBudget = budgetFor_(cfg, "economy");
        const overBudget = ecoBudget !== null && best.price > ecoBudget;
        summaryLines.push("🎯 " + dest + " (" + cur + ")" +
          (overBudget ? " — ⚠️ au-dessus de ton budget (" + ecoBudget + ")" : ""));
        list.slice(0, 3).forEach(function (o, i) {
          summaryLines.push((i + 1) + ". " + o.origin + " " + o.price +
            (ecoBudget !== null && o.price > ecoBudget ? " ⚠️" : "") +
            " · " + fmtDate_(o.departure_at) + "→" + fmtDate_(o.return_at) +
            " · " + o.transfers + " esc. · " + o.airline);
        });
      } else {
        summaryLines.push("   en " + cur + " : min " + best.price + " (" + best.origin + ")");
      }

      if (!pausedNow && (isNewLow || isAnomaly)) {
        sendAlert_(best, dest, cur, prevMin, med, { isNewLow: isNewLow, isAnomaly: isAnomaly }, cfg);
        alerted[key] = best.price;
      }
    });
  });

  if (rows.length > 0) {
    const sheet = getOrCreateSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  lastResult.checkedAt = now.toISOString();
  setJson_("MINS", mins);
  setJson_("ALERTED", alerted);
  setJson_("RECENT", recent);
  setJson_("LAST_RESULT", lastResult);

  if (verbose) {
    const firstBucket = buckets[keys[0]];
    replyTelegram_(summaryLines.join("\n") +
      "\n\n🔗 " + buildLink_(firstBucket[0]) + "\n💡 /status à tout moment, /premium pour les cabines avant.");
  }
}

function sendAlert_(best, dest, cur, prevMin, med, reasons, cfg) {
  const title = reasons.isAnomaly ? "🚨 Probable ERREUR DE PRIX — " + dest + " !" : "🔻 Record battu — " + dest + " !";
  const pctLine = (reasons.isAnomaly && med !== null)
    ? "\n📉 " + Math.round(100 - best.price / med * 100) + "% sous la moyenne (" + Math.round(med) + " " + cur + ")"
    : "";

  const msg = title + "\n\n" +
    "💰 " + best.price + " " + cur + (prevMin !== null ? " (record précédent : " + prevMin + ")" : "") + pctLine + "\n" +
    "🛫 " + best.origin + " → " + dest + " · " + fmtDate_(best.departure_at) + "→" + fmtDate_(best.return_at) +
    " · " + best.transfers + " esc. · " + best.airline + "\n\n" +
    (budgetFor_(cfg, "economy") !== null && cur === cfg.currencies[0] && best.price > budgetFor_(cfg, "economy")
      ? "💸 Au-dessus de ton budget (" + budgetFor_(cfg, "economy") + " " + cur + ")\n" : "") +
    "🔗 " + buildLink_(best) + "\n" +
    "⚠️ Prix issu du cache API (~48h) — vérifie avant d'acheter.";

  replyTelegram_(msg);
}

/** Étend les codes pays de la liste vers leurs aéroports, laisse les codes aéroport tels quels, déduplique. */
function expandOrigins_(rawOrigins) {
  const out = [];
  rawOrigins.forEach(function (entry) {
    const code = entry.toUpperCase();
    if (code.length === 2 && COUNTRY_AIRPORTS[code]) {
      COUNTRY_AIRPORTS[code].forEach(function (airport) {
        if (out.indexOf(airport) === -1) out.push(airport);
      });
    } else {
      if (out.indexOf(code) === -1) out.push(code);
    }
  });
  return out;
}

/** Liste des mois (YYYY-MM) couverts par une fenêtre [from, to]. */
function monthsInWindow_(window) {
  const out = [];
  let y = +window[0].substring(0, 4), m = +window[0].substring(5, 7);
  const ey = +window[1].substring(0, 4), em = +window[1].substring(5, 7);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + "-" + (m < 10 ? "0" + m : m));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function buildApiUrl_(origin, destination, currency, departMonth, returnMonth) {
  const params = {
    origin: origin,
    destination: destination,
    departure_at: departMonth,
    return_at: returnMonth,
    one_way: "false",
    direct: "false",
    sorting: "price",
    unique: "false",
    currency: currency.toLowerCase(),
    limit: "100", // large : on filtre ensuite par fenêtres de dates précises
    token: CONFIG_STATIC.TRAVELPAYOUTS_TOKEN
  };
  return "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + toQuery_(params);
}

/** Exécute un lot de requêtes et range la meilleure offre de chacune dans
 * buckets["destination|devise"]. */
function collectBest_(requests, cfg, buckets) {
  const responses = fetchAllBatched_(requests.map(function (r) { return r.url; }));
  requests.forEach(function (r, i) {
    try {
      const offers = parseOffers_(responses[i], cfg, r.cur);
      if (offers.length > 0) {
        const key = r.dest + "|" + r.cur;
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(offers[0]);
      }
    } catch (e) {
      Logger.log("Erreur pour " + r.origin + "→" + r.dest + " (" + r.cur + ") : " + e);
    }
  });
}

/** Envoie toutes les requêtes par lots parallèles (fetchAll) — bien plus
 * rapide que la boucle séquentielle de la v1. */
function fetchAllBatched_(urls) {
  const out = [];
  for (let i = 0; i < urls.length; i += CONFIG_STATIC.FETCH_BATCH_SIZE) {
    const batch = urls.slice(i, i + CONFIG_STATIC.FETCH_BATCH_SIZE)
      .map(function (u) { return { url: u, muteHttpExceptions: true }; });
    UrlFetchApp.fetchAll(batch).forEach(function (r) { out.push(r); });
    if (i + CONFIG_STATIC.FETCH_BATCH_SIZE < urls.length) Utilities.sleep(250);
  }
  return out;
}

/** Filtre les offres selon TOUS les critères : fenêtres de dates exactes,
 * durée du séjour, escales max, budget (dans la devise principale). */
function parseOffers_(resp, cfg, currency) {
  const json = JSON.parse(resp.getContentText());
  if (!json.success || !json.data) return [];

  return json.data
    .filter(function (o) { return matchesCriteria_(o, cfg, currency); })
    .map(function (o) {
      return {
        origin: o.origin,
        destination: o.destination,
        price: o.price,
        airline: o.airline,
        departure_at: o.departure_at,
        return_at: o.return_at,
        transfers: o.transfers,
        link: o.link
      };
    })
    .sort(function (a, b) { return a.price - b.price; });
}

function matchesCriteria_(o, cfg, currency) {
  if (!o.departure_at || !o.return_at) return false;
  const dep = String(o.departure_at).substring(0, 10);
  const ret = String(o.return_at).substring(0, 10);
  if (dep < cfg.departWindow[0] || dep > cfg.departWindow[1]) return false;
  if (ret < cfg.returnWindow[0] || ret > cfg.returnWindow[1]) return false;

  const nights = Math.round((new Date(ret) - new Date(dep)) / (1000 * 60 * 60 * 24));
  if (nights < cfg.stayMin || nights > cfg.stayMax) return false;

  if (cfg.maxTransfers !== null) {
    if (o.transfers > cfg.maxTransfers) return false;
    if (o.return_transfers !== undefined && o.return_transfers > cfg.maxTransfers) return false;
  }

  // Le budget n'est volontairement PAS un filtre dur : masquer les résultats
  // au-dessus du budget cacherait la réalité du marché (et les affichages
  // deviendraient vides sans explication). Il est annoté ⚠️ dans les résumés.
  return true;
}

function median_(values) {
  if (!values || values.length === 0) return null;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function fmtDate_(iso) {
  // "2026-10-05T..." → "05/10"
  if (!iso) return "?";
  const s = String(iso);
  return s.substring(8, 10) + "/" + s.substring(5, 7);
}

function fmtWindow_(window) {
  return fmtDate_(window[0]) + "–" + fmtDate_(window[1]);
}

function fmtDateTime_(iso) {
  // "2026-10-05T14:30:00.000Z" → "05/10 14:30"
  if (!iso) return "?";
  const s = String(iso);
  return fmtDate_(s) + " " + s.substring(11, 16);
}

function replyTelegram_(text) {
  const url = "https://api.telegram.org/bot" + CONFIG_STATIC.TELEGRAM_BOT_TOKEN + "/sendMessage";
  const resp = UrlFetchApp.fetch(url, {
    method: "post",
    payload: { chat_id: CONFIG_STATIC.TELEGRAM_CHAT_ID, text: text },
    muteHttpExceptions: true
  });
  const body = resp.getContentText();
  if (body.indexOf('"ok":true') === -1) {
    // Visible dans Exécutions > Journaux Cloud — typiquement "chat not found"
    // si TELEGRAM_CHAT_ID est faux, ou "unauthorized" si le token bot est faux.
    Logger.log("Échec d'envoi Telegram : " + body);
  }
}

function buildLink_(o) {
  // L'API renvoie déjà un chemin complet ("/search/…") — ne pas re-préfixer.
  const path = String(o.link || "");
  return "https://www.aviasales.com" + (path.charAt(0) === "/" ? path : "/search/" + path);
}

function toQuery_(params) {
  return Object.keys(params)
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
    .join("&");
}

/**
 * ============ MODULE COMPLÉMENTAIRE : CABINES PREMIUM ============
 * Prix par cabine AVANT (éco premium / affaires / première) via l'API Duffel :
 * de vraies offres LIVE interrogées auprès des compagnies. Duffel cherche en
 * direct (~10-15 s/route) → on plafonne le nombre de recherches et le temps
 * total (voir CONFIG_STATIC). Deux usages : /premium à la demande (aperçu
 * rapide partiel, runPremiumCheck_), et une VEILLE PRÉVENTIVE en fond
 * (sweepPremium) qui balaie toute la matrice par morceaux ~toutes les 4 h et
 * ALERTE dès qu'un prix passe sous ta cible (/budget) ou bat un record. TOUT
 * est protégé par des try/catch — si l'API échoue, le suivi éco continue.
 */

/** Lancement manuel d'un aperçu premium en fond (non déclenché ; utile pour
 * tester depuis l'éditeur). La veille automatique passe par sweepPremium. */
function checkPremiumCabins() {
  runPremiumCheck_(false);
}

/* ---------- VEILLE PRÉVENTIVE DÉCOUPÉE (trigger toutes les 30 min) ---------- */

/** Point d'entrée du trigger : fait avancer le balayage, isolé de toute erreur. */
function sweepPremium() {
  try { sweepPremiumTick_(); }
  catch (e) { Logger.log("sweepPremium — erreur ignorée : " + e); }
}

/** Un « tick » : reprend le balayage complet là où il en était (curseur dans
 * les propriétés), traite un morceau borné en temps/nombre, et alerte au fil
 * de l'eau. Un balayage complet s'étale donc sur plusieurs ticks ; un nouveau
 * balayage ne démarre qu'après PREMIUM_SWEEP_INTERVAL_MS. */
function sweepPremiumTick_() {
  if (!CONFIG_STATIC.PREMIUM_ENABLED) return;
  const cfg = getConfig_();
  if (cfg.paused) return;

  const cabins = cfg.cabins.filter(function (c) {
    return c !== "economy" && duffelCabin_(c) !== null;
  });
  if (cabins.length === 0) return;

  const origins = premiumOrigins_(cfg, CONFIG_STATIC.PREMIUM_SWEEP_MAX_ORIGINS);
  const dates = premiumDates_(cfg);
  // Matrice de routes, ORIGINE-d'abord (couvre toutes les destinations tôt).
  const routes = [];
  origins.forEach(function (o) {
    cfg.destinations.forEach(function (d) {
      cabins.forEach(function (c) { routes.push(o + ">" + d + ">" + c); });
    });
  });
  if (routes.length === 0) return;
  // Signature : si la config change, on redémarre un balayage propre.
  const sig = origins.join(",") + "|" + cfg.destinations.join(",") + "|" +
    cabins.join(",") + "|" + dates.depart + ">" + dates.ret;

  let sweep = getJson_("PREMIUM_SWEEP", null);
  const now = Date.now();
  if (!sweep || sweep.sig !== sig) {
    sweep = { sig: sig, cursor: 0, lastDoneMs: 0 }; // neuf / config changée
  } else if (sweep.cursor >= routes.length) {
    // Balayage précédent terminé : attendre l'intervalle avant d'en relancer un.
    if ((now - (sweep.lastDoneMs || 0)) < CONFIG_STATIC.PREMIUM_SWEEP_INTERVAL_MS) return;
    sweep.cursor = 0;
  }
  // sinon : balayage en cours (cursor < length) → on continue au curseur.

  const sheet = getOrCreatePremiumSheet_();
  const premiumMins = getJson_("PREMIUM_MINS", {});
  const belowState = getJson_("PREMIUM_BELOW", {});
  const lastPremium = getJson_("LAST_PREMIUM", null) || { results: {} };
  if (!lastPremium.results) lastPremium.results = {};

  const startMs = Date.now();
  let processed = 0;
  while (sweep.cursor < routes.length &&
         processed < CONFIG_STATIC.PREMIUM_MAX_REQUESTS &&
         (Date.now() - startMs) < CONFIG_STATIC.PREMIUM_TIME_BUDGET_MS) {
    const parts = routes[sweep.cursor].split(">");
    const origin = parts[0], dest = parts[1], cabin = parts[2];
    sweep.cursor++;
    processed++;
    try {
      const offers = fetchDuffelBusiness_(origin, dest, cabin, dates);
      if (offers.length > 0) {
        const best = offers[0];
        sheet.appendRow([
          new Date(), origin, dest, cabin, best.price, best.currency,
          best.airlines.join(" + "), best.stops, best.departure_at, best.return_at
        ]);
        processPremiumBest_(best, cfg, premiumMins, belowState, lastPremium);
      }
    } catch (e) {
      Logger.log("sweepPremium — échec " + origin + "→" + dest + "/" + cabin + " : " + e);
    }
    Utilities.sleep(200);
  }

  lastPremium.checkedAt = new Date().toISOString();
  setJson_("LAST_PREMIUM", lastPremium);
  setJson_("PREMIUM_MINS", premiumMins);
  setJson_("PREMIUM_BELOW", belowState);
  if (sweep.cursor >= routes.length) {
    sweep.lastDoneMs = Date.now();
    Logger.log("Balayage premium terminé (" + routes.length + " routes).");
  }
  setJson_("PREMIUM_SWEEP", sweep);
}

/** Met à jour les stores (dernier prix, records) pour une offre, et déclenche
 * les alertes : priorité à « sous la cible » (budget), sinon « record battu ».
 * L'alerte sous cible est dédupliquée (on ne re-alerte que si ça baisse
 * encore) et se réarme quand le prix repasse au-dessus de la cible. */
function processPremiumBest_(best, cfg, premiumMins, belowState, lastPremium) {
  const cur = cfg.currencies[0];
  const dest = best.destination, cabin = best.cabin;
  const destKey = cabin + "|" + dest;
  const key = destKey + "|" + best.currency;

  // Dernier meilleur prix connu (pour /status).
  const prevBest = lastPremium.results[destKey];
  if (!prevBest || best.price < prevBest.price) lastPremium.results[destKey] = best;

  // Alerte SOUS LA CIBLE (comparaison seulement si même devise que ta cible).
  let alerted = false;
  const target = budgetFor_(cfg, cabin);
  if (target !== null && best.currency === cur) {
    if (best.price <= target) {
      if (belowState[key] === undefined || best.price < belowState[key]) {
        sendTargetAlert_(best, target);
        belowState[key] = best.price;
        alerted = true;
      }
    } else if (belowState[key] !== undefined) {
      delete belowState[key]; // repassé au-dessus → réarmé pour la prochaine baisse
    }
  }

  // Record historique + alerte record (sauf si on vient déjà d'alerter la cible).
  const prevMin = (key in premiumMins) ? premiumMins[key] : null;
  if (prevMin === null || best.price < prevMin) {
    premiumMins[key] = best.price;
    if (prevMin !== null && !alerted) sendPremiumAlert_(best, prevMin, best.currency);
  }
}

function sendTargetAlert_(best, target) {
  replyTelegram_("🎯 Sous ta cible — " + cabinLabel_(best.cabin) + " " + best.destination + " !\n\n" +
    "💰 " + best.price + " " + best.currency + " (cible ≤ " + target + ")\n" +
    "🛫 " + best.origin + " → " + best.destination + " · " + best.stops + " esc. · " + best.airlines.join(" + ") + "\n\n" +
    "ℹ️ Offre live Duffel — vérifie avant de réserver.");
}

function runPremiumCheck_(verbose) {
  if (!CONFIG_STATIC.PREMIUM_ENABLED) {
    if (verbose) replyTelegram_("Le module premium est désactivé (PREMIUM_ENABLED dans le code).");
    return;
  }

  try {
    const cfg = getConfig_();
    if (cfg.paused && !verbose) {
      Logger.log("Module premium ignoré : en pause.");
      return;
    }

    // Cabines avant choisies dans l'onboarding (/cabines) — l'éco est gérée
    // par le tracker principal, pas par ce module. Duffel couvre toutes les
    // cabines avant (éco premium, affaires, première).
    const wanted = cfg.cabins.filter(function (c) { return c !== "economy"; });
    const cabins = wanted.filter(function (c) { return duffelCabin_(c) !== null; });
    if (cabins.length === 0) {
      Logger.log("Module premium : aucune cabine avant suivie (voir /cabines).");
      if (verbose) replyTelegram_("Aucune cabine avant suivie. Ajoute-en avec /cabines (ex : /cabines eco affaires).");
      return;
    }

    const cur = cfg.currencies[0];
    const dates = premiumDates_(cfg); // Duffel exige des dates précises
    const origins = premiumOrigins_(cfg); // un hub par pays, spread géographique
    const sheet = getOrCreatePremiumSheet_();
    const now = new Date();
    const startMs = Date.now();
    const premiumMins = getJson_("PREMIUM_MINS", {});
    const results = []; // { cabin, destination, price, currency, origin, airlines, stops, departure_at, return_at }
    const failReasons = {}; // ex. { "Duffel offers HTTP 401 : ...": 6 }
    let emptyCount = 0;    // requêtes OK mais sans offre pour ce (route, cabine)
    let attempts = 0, failCount = 0, aborted = false, budgetHit = false;

    // Boucle ORIGINE-d'abord : chaque destination reçoit le meilleur hub avant
    // qu'on approfondisse, pour que TOUTES soient couvertes malgré le budget.
    origins.forEach(function (origin) {
      cfg.destinations.forEach(function (dest) {
        cabins.forEach(function (cabin) {
          if (aborted) return;
          // Garde-fous anti-timeout : plafond de recherches et budget-temps
          // (Duffel interroge les compagnies en direct, c'est lent).
          if (attempts >= CONFIG_STATIC.PREMIUM_MAX_REQUESTS ||
              (Date.now() - startMs) > CONFIG_STATIC.PREMIUM_TIME_BUDGET_MS) {
            budgetHit = true; aborted = true; return;
          }
          attempts++;
          try {
            const offers = fetchDuffelBusiness_(origin, dest, cabin, dates);
            if (offers.length > 0) {
              const best = offers[0];
              results.push(best);
              sheet.appendRow([
                now, origin, dest, cabin, best.price, best.currency,
                best.airlines.join(" + "), best.stops, best.departure_at, best.return_at
              ]);
            } else {
              emptyCount++;
            }
          } catch (e) {
            const reason = String((e && e.message) || e);
            failReasons[reason] = (failReasons[reason] || 0) + 1;
            failCount++;
            Logger.log("Module premium — échec pour " + origin + "→" + dest + "/" + cabin + " : " + e);
          }
          // Panne systémique (ex. HTTP 401/403 Duffel) : si les 4 premières
          // requêtes échouent TOUTES sur la même erreur, on coupe (inutile de
          // brûler du temps). Une simple absence d'offre ne déclenche rien.
          if (results.length === 0 && attempts >= 4 && failCount === attempts &&
              Object.keys(failReasons).length === 1) aborted = true;
          Utilities.sleep(200);
        });
      });
    });

    if (results.length === 0) {
      // On dit POURQUOI (jamais de fallback silencieux) : raison dominante +
      // compte, pour distinguer un souci d'accès d'une simple absence d'offre.
      const reasonsSorted = Object.keys(failReasons).sort(function (a, b) {
        return failReasons[b] - failReasons[a];
      });
      const diag = reasonsSorted.length
        ? reasonsSorted.map(function (r) { return r + " (×" + failReasons[r] + ")"; }).join(", ")
        : (emptyCount > 0 ? "aucune offre sur ces routes/dates" : "aucune requête envoyée");
      Logger.log("Module premium : aucun résultat. Causes : " + diag);
      if (verbose) {
        replyTelegram_("😕 Aucun prix premium obtenu.\n\nCause : " + diag +
          ".\n\nℹ️ « HTTP 401/403 » = jeton Duffel invalide ou en mode test ; « aucune offre » = pas de vol dans cette cabine aux dates testées (" +
          fmtDate_(dates.depart) + "→" + fmtDate_(dates.ret) + ").");
      }
      return;
    }

    // Meilleur prix par (cabine, destination), alertes sur nouveaux records —
    // jamais au tout premier relevé (référence seulement). Duffel fixe lui-même
    // la devise de chaque offre : on l'affiche et on l'inclut dans les clés.
    const lastPremium = { checkedAt: now.toISOString(), results: {} };
    const summaryLines = ["🥂 Cabines premium (" + fmtDate_(dates.depart) + "→" + fmtDate_(dates.ret) + ")"];
    cfg.destinations.forEach(function (dest) {
      let destShown = false;
      cabins.forEach(function (cabin) {
        const forKey = results.filter(function (r) { return r.cabin === cabin && r.destination === dest; });
        if (forKey.length === 0) return;
        forKey.sort(function (a, b) { return a.price - b.price; });
        const best = forKey[0];
        if (!destShown) { summaryLines.push("\n🎯 " + dest); destShown = true; }
        const cabBudget = budgetFor_(cfg, cabin);
        const overBudget = cabBudget !== null && best.currency === cur && best.price > cabBudget;
        summaryLines.push(cabinLabel_(cabin) + " : " + best.price + " " + best.currency +
          " (" + best.origin + ", " + best.stops + " esc.)" + (overBudget ? " ⚠️ > " + cabBudget : ""));
        lastPremium.results[cabin + "|" + dest] = best;

        const key = cabin + "|" + dest + "|" + best.currency;
        const prevMin = (key in premiumMins) ? premiumMins[key] : null;
        if (prevMin === null || best.price < prevMin) {
          premiumMins[key] = best.price;
          if (prevMin !== null && !verbose) sendPremiumAlert_(best, prevMin, best.currency);
        }
      });
    });
    setJson_("PREMIUM_MINS", premiumMins);
    setJson_("LAST_PREMIUM", lastPremium);

    if (verbose) replyTelegram_(summaryLines.join("\n") +
      (budgetHit ? "\n\n⏱️ Recherche écourtée (plafond de temps/requêtes) — résultats partiels." : "") +
      "\n\nℹ️ Offres live Duffel — vérifie le prix exact avant de réserver.");
  } catch (e) {
    // Filet de sécurité global : quoi qu'il arrive, ce module ne doit
    // jamais faire planter le trigger ni affecter le suivi éco.
    Logger.log("Module premium — erreur générale, ignorée : " + e);
    if (verbose) replyTelegram_("😕 Le module premium a rencontré une erreur (voir les journaux Apps Script).");
  }
}

/** Cabine interne → valeur cabin_class de Duffel. Renvoie null pour l'éco
 * (gérée par le tracker principal, jamais interrogée ici). */
function duffelCabin_(cabin) {
  return {
    "premium-economy": "premium_economy",
    "business": "business",
    "first": "first"
  }[cabin] || null;
}

/** Origines pour /premium : UN hub par pays/ville de départ (le 1er aéroport),
 * pour un vrai spread géographique plutôt que 5 aéroports du même pays. Duffel
 * étant lent, on plafonne à PREMIUM_MAX_ORIGINS pour tenir le budget-temps. */
function premiumOrigins_(cfg, max) {
  const cap = max || CONFIG_STATIC.PREMIUM_MAX_ORIGINS;
  const out = [];
  cfg.origins.forEach(function (entry) {
    const code = entry.toUpperCase();
    const hub = (code.length === 2 && COUNTRY_AIRPORTS[code]) ? COUNTRY_AIRPORTS[code][0] : code;
    if (out.indexOf(hub) === -1) out.push(hub);
  });
  return out.slice(0, cap);
}

/** Duffel exige des dates précises : on échantillonne le début de la fenêtre
 * de départ + un séjour moyen (comme le faisait l'ancien module). */
function premiumDates_(cfg) {
  const depart = cfg.departWindow[0];
  const days = Math.round((cfg.stayMin + cfg.stayMax) / 2);
  const d = new Date(depart + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return { depart: depart, ret: d.toISOString().substring(0, 10) };
}

function budgetsLabel_(cfg) {
  const parts = cfg.cabins
    .filter(function (c) { return budgetFor_(cfg, c) !== null; })
    .map(function (c) { return cabinLabel_(c) + " " + budgetFor_(cfg, c); });
  return parts.length > 0 ? " · 💰 max " + parts.join(", ") + " " + cfg.currencies[0] : "";
}

function budgetFor_(cfg, cabin) {
  const b = cfg.budgets && cfg.budgets[cabin];
  return (b === undefined || b === null) ? null : b;
}

function cabinLabel_(cabin) {
  return { "economy": "Éco", "premium-economy": "Éco premium", "business": "Affaires", "first": "Première" }[cabin] || cabin;
}

/** Extrait un message lisible d'une réponse d'erreur Duffel (JSON {errors:[…]}). */
function duffelErr_(raw) {
  try {
    const e = JSON.parse(raw);
    if (e.errors && e.errors[0]) {
      return (e.errors[0].title || "erreur") +
        (e.errors[0].message ? " — " + e.errors[0].message : "");
    }
  } catch (x) { /* corps non JSON */ }
  return String(raw).slice(0, 120);
}

/** Offres aller-retour d'une cabine avant via l'API Duffel (offres LIVE).
 * 1) crée une demande d'offres, 2) récupère les offres triées par prix.
 * Renvoie [{ cabin, origin, destination, price, currency, airlines, stops,
 * departure_at, return_at }] triées du moins cher au plus cher. */
function fetchDuffelBusiness_(origin, destination, cabin, dates) {
  const cabinClass = duffelCabin_(cabin);
  if (cabinClass === null) throw new Error(cabinLabel_(cabin) + " non gérée");

  const headers = {
    "Authorization": "Bearer " + CONFIG_STATIC.DUFFEL_TOKEN,
    "Duffel-Version": "v2",
    "Accept": "application/json"
  };

  // 1) Demande d'offres (return_offers=false : on récupère juste l'id, puis on
  // trie/pagine côté serveur). supplier_timeout borne l'attente des compagnies.
  const reqBody = {
    data: {
      slices: [
        { origin: origin, destination: destination, departure_date: dates.depart },
        { origin: destination, destination: origin, departure_date: dates.ret }
      ],
      passengers: [{ type: "adult" }],
      cabin_class: cabinClass
    }
  };
  const createResp = UrlFetchApp.fetch(
    "https://api.duffel.com/air/offer_requests?return_offers=false&supplier_timeout=12000", {
      method: "post",
      contentType: "application/json",
      headers: headers,
      payload: JSON.stringify(reqBody),
      muteHttpExceptions: true
    });
  const cCode = createResp.getResponseCode();
  const cRaw = createResp.getContentText();
  if (cCode !== 201 && cCode !== 200) {
    throw new Error("Duffel create HTTP " + cCode + " : " + duffelErr_(cRaw));
  }
  const created = JSON.parse(cRaw);
  const reqId = created.data && created.data.id;
  if (!reqId) throw new Error("Duffel : pas d'offer_request id");

  // 2) Offres triées par prix croissant.
  const offersResp = UrlFetchApp.fetch(
    "https://api.duffel.com/air/offers?offer_request_id=" + encodeURIComponent(reqId) +
    "&sort=total_amount&limit=20", {
      method: "get", headers: headers, muteHttpExceptions: true
    });
  const oCode = offersResp.getResponseCode();
  const oRaw = offersResp.getContentText();
  if (oCode !== 200) throw new Error("Duffel offers HTTP " + oCode + " : " + duffelErr_(oRaw));

  const offers = (JSON.parse(oRaw).data) || [];
  const out = offers.map(function (o) {
    const outbound = (o.slices && o.slices[0] && o.slices[0].segments) || [];
    const airline = (o.owner && (o.owner.name || o.owner.iata_code)) || "?";
    return {
      cabin: cabin,
      origin: origin,
      destination: destination,
      price: Math.round(parseFloat(o.total_amount)),
      currency: o.total_currency,
      airlines: [airline],
      stops: Math.max(0, outbound.length - 1),
      departure_at: dates.depart,
      return_at: dates.ret
    };
  });
  out.sort(function (a, b) { return a.price - b.price; });
  return out;
}

function sendPremiumAlert_(best, previousMin, cur) {
  const msg = "🥂 Record battu — " + cabinLabel_(best.cabin) + " " + best.destination + " !\n\n" +
    "💰 " + best.price + " " + cur + " (record précédent : " + previousMin + ")\n" +
    "🛫 " + best.origin + " → " + best.destination + " · " + best.stops + " esc. · " + best.airlines.join(" + ") + "\n\n" +
    "ℹ️ Offre live Duffel — vérifie avant de réserver.";
  replyTelegram_(msg);
}

function getOrCreatePremiumSheet_() {
  const ss = getOrCreateSpreadsheet_();
  let sheet = ss.getSheetByName("Log Premium");
  if (!sheet) {
    sheet = ss.insertSheet("Log Premium");
    sheet.appendRow([
      "Date vérification", "Origine", "Destination", "Cabine", "Prix", "Devise",
      "Compagnie(s)", "Escales", "Date départ testée", "Date retour testée"
    ]);
  }
  return sheet;
}

/** ---- Google Sheet ---- */
function getOrCreateSpreadsheet_() {
  let ss;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    ss = null;
  }
  if (!ss) {
    const files = DriveApp.getFilesByName(CONFIG_STATIC.SHEET_NAME);
    ss = files.hasNext() ? SpreadsheetApp.open(files.next()) : SpreadsheetApp.create(CONFIG_STATIC.SHEET_NAME);
  }
  return ss;
}

// Onglet "Log v2" : ajoute la colonne Devise par rapport à l'ancien "Log"
// (conservé intact si tu viens de la v1).
function getOrCreateSheet_() {
  const ss = getOrCreateSpreadsheet_();
  let sheet = ss.getSheetByName("Log v2");
  if (!sheet) {
    sheet = ss.insertSheet("Log v2");
    sheet.appendRow([
      "Date vérification", "Origine", "Destination", "Devise", "Prix",
      "Compagnie", "Départ", "Retour", "Escales", "Lien"
    ]);
  }
  return sheet;
}

/** ---- État persisté (PropertiesService), découpé par responsabilité ----
 * CONFIG       : écrit uniquement par les commandes Telegram
 * WIZARD       : étape en cours de l'assistant /config
 * MINS         : records par "destination|devise" (écrit par runCheck_)
 * ALERTED      : dernier prix alerté par "destination|devise" (anti-spam)
 * RECENT       : derniers relevés par "destination|devise" (seuil dynamique)
 * LAST_RESULT  : derniers meilleurs prix (pour /status)
 * LAST_PREMIUM : derniers prix par cabine (pour /status)
 * PREMIUM_MINS : records par "cabine|destination|devise"
 * TG_OFFSET    : curseur getUpdates (polling Telegram)
 * Ce découpage élimine la race condition de la v1 où checkPrices ré-écrivait
 * tout l'état (pause comprise) à la fin de son exécution. */
function props_() {
  return PropertiesService.getScriptProperties();
}

function getJson_(key, fallback) {
  const raw = props_().getProperty(key);
  return raw ? JSON.parse(raw) : fallback;
}

function setJson_(key, value) {
  props_().setProperty(key, JSON.stringify(value));
}

function defaultConfig_() {
  return {
    destinations: CONFIG_STATIC.DEFAULT_DESTINATIONS.slice(),
    origins: CONFIG_STATIC.DEFAULT_ORIGINS.slice(),
    currencies: CONFIG_STATIC.DEFAULT_CURRENCIES.slice(),
    departWindow: CONFIG_STATIC.DEFAULT_DEPART_WINDOW.slice(),
    returnWindow: CONFIG_STATIC.DEFAULT_RETURN_WINDOW.slice(),
    stayMin: CONFIG_STATIC.DEFAULT_STAY[0],
    stayMax: CONFIG_STATIC.DEFAULT_STAY[1],
    cabins: ["economy"],
    maxTransfers: null,
    budgets: {}, // budget max par cabine, ex. { economy: 700, business: 2500 }
    alertPct: CONFIG_STATIC.DEFAULT_ALERT_PCT,
    paused: false
  };
}

function getConfig_() {
  const defaults = defaultConfig_();
  let cfg = getJson_("CONFIG", null);

  if (!cfg) {
    // Migration depuis la v1 (clé STATE unique) si elle existe.
    const old = getJson_("STATE", null);
    cfg = defaults;
    if (old) {
      if (old.origins) cfg.origins = old.origins;
      cfg.paused = !!old.paused;
      props_().deleteProperty("STATE");
    }
    saveConfig_(cfg);
    return cfg;
  }

  // Complète les champs manquants (config créée par une version antérieure,
  // ex. v2.0/2.1 sans fenêtres de dates ni alertPct). L'ancien seuil absolu
  // (alertBelow) est abandonné au profit du seuil dynamique.
  let dirty = false;
  Object.keys(defaults).forEach(function (k) {
    if (cfg[k] === undefined) { cfg[k] = defaults[k]; dirty = true; }
  });
  if (cfg.alertBelow !== undefined) { delete cfg.alertBelow; dirty = true; }
  // v2.4 → v2.5 : budget unique → budgets par cabine.
  if (cfg.budget !== undefined) {
    if (cfg.budget !== null) cfg.budgets.economy = cfg.budget;
    delete cfg.budget;
    dirty = true;
  }
  if (dirty) saveConfig_(cfg);
  return cfg;
}

function saveConfig_(cfg) {
  setJson_("CONFIG", cfg);
}
