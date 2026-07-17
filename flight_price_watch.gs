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
 * L'éco est suivie toutes les 30 min via l'API ; les cabines avant (éco
 * premium, affaires, first) 1x/jour + /premium à la demande, via le module
 * Google Flights (limite du scraping gratuit).
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
 * MODULE COMPLÉMENTAIRE — cabines premium (éco premium / affaires /
 * première) : scraping non officiel de Google Flights, 1x/jour + à la
 * demande via /premium, entièrement isolé par try/catch. S'il casse (Google
 * peut changer sa page), le suivi éco continue normalement.
 */

const SCRIPT_VERSION = "2.7";

/************ CONFIGURATION STATIQUE — à personnaliser une fois ************/
const CONFIG_STATIC = {
  TRAVELPAYOUTS_TOKEN: "COLLE_TON_TOKEN_TRAVELPAYOUTS_ICI",
  TELEGRAM_BOT_TOKEN: "COLLE_TON_TOKEN_TELEGRAM_ICI",
  TELEGRAM_CHAT_ID: "COLLE_TON_CHAT_ID_ICI",

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
  PREMIUM_MAX_ORIGINS: 5 // limite le nombre de villes interrogées (volume = risque de blocage)
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
    ScriptApp.newTrigger("checkPremiumCabins").timeBased().everyDays(1).atHour(8).create();
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
      (cabins.indexOf("economy") === -1 ? "\n⚠️ Éco non suivie : les vérifications 30 min sont suspendues, cabines avant 1x/jour + /premium." : ""));

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
        "ℹ️ L'éco est vérifiée toutes les 30 min ; les cabines avant 1x/jour + /premium.";
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
    // sinon sondage Google Flights sur 3 villes (~10 s, best effort).
    if (cabin && cabin !== "economy") {
      const prem = getJson_("LAST_PREMIUM", null);
      for (let i = 0; i < cfg.destinations.length; i++) {
        const d = cfg.destinations[i];
        if (prem && prem.results && prem.results[cabin + "|" + d]) {
          const known = prem.results[cabin + "|" + d];
          return "\n📊 Repère " + cabinLabel_(cabin) + " " + d + " : " + known.price + " " + prem.currency + " (" + known.origin + ")";
        }
      }
      const dates = premiumDates_(cfg);
      const premPrices = [];
      expandOrigins_(cfg.origins).slice(0, 3).forEach(function (origin) {
        try {
          const offers = fetchGoogleFlightsOffers_(origin, cfg.destinations[0], cabin, cur, dates);
          if (offers.length > 0) premPrices.push(offers[0].price);
        } catch (e) { /* scraping non garanti : le repère est facultatif */ }
      });
      if (premPrices.length === 0) return "\n(pas de repère dispo pour cette cabine — essaie /premium après la config)";
      return "\n📊 Repère " + cabinLabel_(cabin) + " " + cfg.destinations[0] + " : meilleur constaté " + Math.min.apply(null, premPrices) + " " + cur;
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
    lines.push("\n🥂 Cabines (" + fmtDateTime_(prem.checkedAt) + ", " + prem.currency + ") :");
    Object.keys(prem.results).sort().forEach(function (k) {
      const p = prem.results[k];
      lines.push(cabinLabel_(p.cabin) + " " + p.destination + " : " + p.price + " (" + p.origin + ", " + p.stops + " esc.)");
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
    "/premium — prix affaires/première\n" +
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
 * Interroge directement Google Flights (comme le ferait ton navigateur)
 * pour obtenir des prix par cabine (éco premium / affaires / première),
 * ce que l'API Travelpayouts ne sait pas faire. Scraping non officiel :
 * volontairement peu fréquent (1x/jour + /premium à la demande), et TOUT est
 * protégé par des try/catch — si Google bloque ou change sa page, ce module
 * échoue en silence et le suivi éco principal continue sans interruption.
 */

/** Trigger quotidien (l'événement du trigger est ignoré). */
function checkPremiumCabins() {
  runPremiumCheck_(false);
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
    // par le tracker principal, pas par ce module.
    const cabins = cfg.cabins.filter(function (c) { return c !== "economy"; });
    if (cabins.length === 0) {
      Logger.log("Module premium : aucune cabine avant suivie (voir /cabines).");
      if (verbose) replyTelegram_("Aucune cabine avant suivie. Ajoute-en avec /cabines (ex : /cabines eco affaires).");
      return;
    }

    const cur = cfg.currencies[0];
    const dates = premiumDates_(cfg);
    const origins = expandOrigins_(cfg.origins).slice(0, CONFIG_STATIC.PREMIUM_MAX_ORIGINS);
    const sheet = getOrCreatePremiumSheet_();
    const now = new Date();
    const premiumMins = getJson_("PREMIUM_MINS", {});
    const results = []; // { cabin, destination, price, origin, airlines, stops }
    const failReasons = {}; // ex. { "mur de consentement Google": 12 }
    let emptyCount = 0;    // requêtes OK mais sans offre pour ce (route, cabine)
    let attempts = 0, blockFails = 0, aborted = false;
    const BLOCKING_ = { "mur de consentement Google": 1, "bloqué anti-bot Google": 1, "structure ds:1 introuvable": 1 };

    cfg.destinations.forEach(function (dest) {
      cabins.forEach(function (cabin) {
        origins.forEach(function (origin) {
          if (aborted) return;
          attempts++;
          try {
            const offers = fetchGoogleFlightsOffers_(origin, dest, cabin, cur, dates);
            if (offers.length > 0) {
              const best = offers[0];
              results.push(best);
              sheet.appendRow([
                now, origin, dest, cabin, best.price, cur,
                best.airlines.join(" + "), best.stops, dates.depart, dates.ret
              ]);
            } else {
              emptyCount++;
            }
          } catch (e) {
            const reason = String((e && e.message) || e);
            failReasons[reason] = (failReasons[reason] || 0) + 1;
            if (BLOCKING_[reason]) blockFails++;
            Logger.log("Module premium — échec pour " + origin + "→" + dest + "/" + cabin + " : " + e);
          }
          // Google bloque les IP serveur : si les 6 premières requêtes échouent
          // TOUTES sur un blocage, inutile d'en enchaîner 40 (timeout Apps Script).
          if (results.length === 0 && attempts >= 6 && blockFails === attempts) aborted = true;
          Utilities.sleep(300);
        });
      });
    });

    if (results.length === 0) {
      // On dit POURQUOI (jamais de fallback silencieux) : raison dominante +
      // compte, pour distinguer un blocage Google d'une simple absence d'offre.
      const reasonsSorted = Object.keys(failReasons).sort(function (a, b) {
        return failReasons[b] - failReasons[a];
      });
      const diag = reasonsSorted.length
        ? reasonsSorted.map(function (r) { return r + " (×" + failReasons[r] + ")"; }).join(", ")
        : (emptyCount > 0 ? "aucune offre affaires/première sur ces dates" : "aucune requête envoyée");
      Logger.log("Module premium : aucun résultat. Causes : " + diag);
      if (verbose) {
        replyTelegram_("😕 Aucun prix premium obtenu.\n\nCause : " + diag +
          ".\n\nℹ️ « consentement » ou « anti-bot » = Google bloque les requêtes serveur d'Apps Script ; « aucune offre » = pas de vol dans cette cabine aux dates testées (" +
          fmtDate_(dates.depart) + "→" + fmtDate_(dates.ret) + ").");
      }
      return;
    }

    // Meilleur prix par (cabine, destination), alertes sur nouveaux records —
    // jamais au tout premier relevé (référence seulement).
    const lastPremium = { checkedAt: now.toISOString(), currency: cur, results: {} };
    const summaryLines = ["🥂 Cabines premium (" + fmtDate_(dates.depart) + "→" + fmtDate_(dates.ret) + ", " + cur + ")"];
    cfg.destinations.forEach(function (dest) {
      let destShown = false;
      cabins.forEach(function (cabin) {
        const forKey = results.filter(function (r) { return r.cabin === cabin && r.destination === dest; });
        if (forKey.length === 0) return;
        forKey.sort(function (a, b) { return a.price - b.price; });
        const best = forKey[0];
        if (!destShown) { summaryLines.push("\n🎯 " + dest); destShown = true; }
        const cabBudget = budgetFor_(cfg, cabin);
        summaryLines.push(cabinLabel_(cabin) + " : " + best.price + " (" + best.origin + ", " + best.stops + " esc.)" +
          (cabBudget !== null && best.price > cabBudget ? " ⚠️ > " + cabBudget : ""));
        lastPremium.results[cabin + "|" + dest] = best;

        const key = cabin + "|" + dest + "|" + cur;
        const prevMin = (key in premiumMins) ? premiumMins[key] : null;
        if (prevMin === null || best.price < prevMin) {
          premiumMins[key] = best.price;
          if (prevMin !== null && !verbose) sendPremiumAlert_(best, prevMin, cur);
        }
      });
    });
    setJson_("PREMIUM_MINS", premiumMins);
    setJson_("LAST_PREMIUM", lastPremium);

    if (verbose) replyTelegram_(summaryLines.join("\n") + "\n\n⚠️ Scraping non officiel de Google Flights — vérifie avant de réserver.");
  } catch (e) {
    // Filet de sécurité global : quoi qu'il arrive, ce module ne doit
    // jamais faire planter le trigger ni affecter le suivi éco.
    Logger.log("Module premium — erreur générale, ignorée : " + e);
    if (verbose) replyTelegram_("😕 Le module premium a rencontré une erreur (voir les journaux Apps Script).");
  }
}

/** Google Flights exige des dates précises (pas de fenêtre flexible) : on
 * échantillonne le début de la fenêtre de départ + un séjour moyen. */
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

function fetchGoogleFlightsOffers_(origin, destination, cabin, currency, dates) {
  const tfs = buildTfs_(
    [
      { date: dates.depart, from: origin, to: destination },
      { date: dates.ret, from: destination, to: origin }
    ],
    cabin, "round-trip", 1
  );

  const url = "https://www.google.com/travel/flights?tfs=" + encodeURIComponent(tfs) +
    "&hl=en&curr=" + currency.toUpperCase();

  const resp = UrlFetchApp.fetch(url, {
    method: "get",
    headers: {
      "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+000; SOCS=CAI",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    },
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error("HTTP " + resp.getResponseCode());
  }

  const html = resp.getContentText();
  const scriptMatch = html.match(/<script class="ds:1"[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) {
    // Aide au diagnostic : depuis les IP de datacenter d'Apps Script, Google
    // sert souvent un mur de consentement ou une page anti-bot SANS le bloc
    // ds:1. On qualifie la cause au lieu d'un vague « structure introuvable ».
    if (/unusual traffic|not a robot|detected unusual|sorry\/index|recaptcha/i.test(html)) {
      throw new Error("bloqué anti-bot Google");
    }
    if (/consent\.google|before you continue|avant de continuer|isConsentBanner/i.test(html)) {
      throw new Error("mur de consentement Google");
    }
    throw new Error("structure ds:1 introuvable");
  }

  const js = scriptMatch[1];
  const idx = js.indexOf("data:");
  if (idx === -1) throw new Error("pas de champ data: dans le script");
  const afterData = js.substring(idx + 5);
  const lastComma = afterData.lastIndexOf(",");
  const payload = JSON.parse(afterData.substring(0, lastComma));

  const flightsRaw = payload[3] && payload[3][0];
  if (!flightsRaw) return [];

  const out = flightsRaw.map(function (k) {
    const flight = k[0];
    const price = k[1][0][1];
    const airlines = flight[1];
    const stops = flight[2].length - 1;
    return { cabin: cabin, origin: origin, destination: destination, price: price, airlines: airlines, stops: stops };
  });
  out.sort(function (a, b) { return a.price - b.price; });
  return out;
}

function sendPremiumAlert_(best, previousMin, cur) {
  const msg = "🥂 Record battu — " + cabinLabel_(best.cabin) + " " + best.destination + " !\n\n" +
    "💰 " + best.price + " " + cur + " (record précédent : " + previousMin + ")\n" +
    "🛫 " + best.origin + " → " + best.destination + " · " + best.stops + " esc. · " + best.airlines.join(" + ") + "\n\n" +
    "⚠️ Scraping non officiel de Google Flights — vérifie avant de réserver.";
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

/** ---- Encodeur protobuf minimal (juste ce dont Google Flights a besoin) ---- */
function pbVarint_(n) {
  const out = [];
  while (true) {
    const b = n & 0x7f;
    n = n >>> 7;
    if (n) { out.push(b | 0x80); } else { out.push(b); break; }
  }
  return out;
}

function pbTag_(fieldNo, wireType) {
  return pbVarint_((fieldNo << 3) | wireType);
}

function pbBytesField_(fieldNo, payloadBytes) {
  return pbTag_(fieldNo, 2).concat(pbVarint_(payloadBytes.length)).concat(payloadBytes);
}

function pbVarintField_(fieldNo, value) {
  return pbTag_(fieldNo, 0).concat(pbVarint_(value));
}

function asciiBytes_(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
  return out;
}

function pbAirport_(code) {
  return pbBytesField_(2, asciiBytes_(code));
}

function pbFlightLeg_(date, from, to) {
  let b = [];
  b = b.concat(pbBytesField_(2, asciiBytes_(date)));
  b = b.concat(pbBytesField_(13, pbAirport_(from)));
  b = b.concat(pbBytesField_(14, pbAirport_(to)));
  return b;
}

const SEAT_CODE_ = { "economy": 1, "premium-economy": 2, "business": 3, "first": 4 };
const TRIP_CODE_ = { "round-trip": 1, "one-way": 2, "multi-city": 3 };

/** legs: [{date:'YYYY-MM-DD', from:'CDG', to:'ICN'}, ...] */
function buildTfs_(legs, seat, trip, adults) {
  let b = [];
  legs.forEach(function (leg) {
    b = b.concat(pbBytesField_(3, pbFlightLeg_(leg.date, leg.from, leg.to)));
  });
  let passengerBytes = [];
  for (let i = 0; i < adults; i++) passengerBytes = passengerBytes.concat(pbVarint_(1)); // 1 = ADULT
  b = b.concat(pbBytesField_(8, passengerBytes));
  b = b.concat(pbVarintField_(9, SEAT_CODE_[seat]));
  b = b.concat(pbVarintField_(19, TRIP_CODE_[trip]));
  return Utilities.base64Encode(b);
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
