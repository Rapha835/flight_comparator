/**
 * FLIGHT PRICE WATCH v2 — multi-destinations, multi-devises
 *
 * Surveille les prix de vols vers PLUSIEURS destinations en parallèle,
 * dans PLUSIEURS devises (utile pour repérer les erreurs de prix visibles
 * dans une seule devise), depuis les villes/aéroports de ton choix (un code
 * pays comme "FR" s'étend automatiquement vers ses principaux aéroports).
 *
 * Historique dans une Google Sheet, alertes Telegram uniquement quand :
 *   - un prix bat son record historique (par destination + devise), ou
 *   - un prix est anormalement bas vs l'historique récent (probable
 *     erreur de prix : ≤ ANOMALY_RATIO × médiane), ou
 *   - un prix passe sous ton seuil (/seuil) — une seule fois par baisse,
 *     jamais deux alertes pour le même prix.
 *
 * Tourne 100% côté serveur Google (Apps Script), gratuit, rien à héberger.
 *
 * Pilotage à distance via Telegram (voir handleCommand_ plus bas) :
 *   /demarrer ICN   → ajoute/active une destination + check immédiat
 *   ICN (tout court) → pareil que /demarrer ICN
 *   /retirer ICN     → retire une destination (ou une ville de départ)
 *   /ajouter FR       → ajoute un pays ou un aéroport de départ
 *   /devises EUR USD   → change les devises suivies
 *   /seuil 600          → seuil d'alerte (dans la 1ère devise)
 *   /pause /reprendre    → suspend / relance la surveillance
 *   /check                → force une vérification immédiate
 *   /liste /status /aide   → config, derniers prix, aide
 *
 * Source de données : Travelpayouts / Aviasales Data API (gratuite, cache
 * jusqu'à ~48h basé sur les recherches réelles des utilisateurs Aviasales).
 * => Toujours revérifier le prix exact avant d'acheter.
 *
 * IMPORTANT — mise à jour du code : le déploiement Web App fige le code au
 * moment du déploiement. Après CHAQUE modification, il faut faire
 * Déployer > Gérer les déploiements > ✏️ > Version : "Nouvelle version".
 * L'URL /exec ne change pas, le webhook Telegram reste valide. Vérifie avec
 * /aide que la version affichée correspond bien à SCRIPT_VERSION ci-dessous.
 *
 * IMPORTANT — codes pays : testé en direct, un code pays sur cette API ne
 * renvoie PAS les prix de tous les aéroports du pays (ex: DE → seulement
 * Francfort). Le script étend donc lui-même chaque code pays via
 * COUNTRY_AIRPORTS ci-dessous.
 *
 * MODULE COMPLÉMENTAIRE — cabines premium (checkPremiumCabins) : scraping
 * non officiel de Google Flights, 1x/jour, entièrement isolé par try/catch.
 * S'il casse (Google peut changer sa page), le suivi éco continue normalement.
 */

const SCRIPT_VERSION = "2.0";

/************ CONFIGURATION STATIQUE — à personnaliser une fois ************/
const CONFIG_STATIC = {
  TRAVELPAYOUTS_TOKEN: "COLLE_TON_TOKEN_TRAVELPAYOUTS_ICI",
  TELEGRAM_BOT_TOKEN: "COLLE_TON_TOKEN_TELEGRAM_ICI",
  TELEGRAM_CHAT_ID: "COLLE_TON_CHAT_ID_ICI",

  // À remplir APRÈS avoir déployé le script en "Web app" (voir guide) —
  // nécessaire uniquement pour que registerWebhook() fonctionne.
  WEB_APP_URL: "COLLE_ICI_L_URL_DE_DEPLOIEMENT_/exec",

  DEPARTURE_MONTH: "2026-10", // mois de départ surveillé (YYYY-MM)
  RETURN_MONTH: "2026-10",    // mois de retour surveillé (YYYY-MM)

  TRIP_DURATION_MIN: 7,   // durée de séjour mini (jours) — filtre les A/R trop courts
  TRIP_DURATION_MAX: 21,  // durée de séjour maxi (jours)

  // Nom du fichier Google Sheet dans ton Drive (réutilisé s'il existe déjà).
  SHEET_NAME: "Historique prix Corée du Sud",

  // Config de DÉPART au tout premier lancement (setup()). Ensuite, tout se
  // pilote via Telegram — modifier ces valeurs plus tard n'a aucun effet,
  // seul l'état stocké dans PropertiesService compte.
  // "SEL" couvre Séoul-Incheon (ICN) + Gimpo (GMP) ; "ICN" ne cible qu'Incheon.
  DEFAULT_DESTINATIONS: ["SEL"],
  DEFAULT_ORIGINS: ["FR", "BE", "NL", "GB", "DE", "ES", "IT", "PT", "CH"],
  DEFAULT_CURRENCIES: ["EUR", "USD"], // la 1ère est la devise "principale" (seuil)
  DEFAULT_ALERT_BELOW: 650,

  // Détection d'anomalie (probable erreur de prix) : alerte si le meilleur
  // prix ≤ ANOMALY_RATIO × médiane des RECENT_WINDOW derniers relevés,
  // à partir de ANOMALY_MIN_SAMPLES relevés accumulés.
  ANOMALY_RATIO: 0.6,
  ANOMALY_MIN_SAMPLES: 10,
  RECENT_WINDOW: 30,

  // Requêtes API envoyées en parallèle par lots (rapide sans matraquer l'API).
  FETCH_BATCH_SIZE: 15,

  // --- Module cabines premium (checkPremiumCabins) ---
  PREMIUM_ENABLED: true,
  PREMIUM_CABINS: ["premium-economy", "business", "first"],
  PREMIUM_MAX_ORIGINS: 5, // limite le nombre de villes interrogées (volume = risque de blocage)
  // Google Flights n'a pas de mode "n'importe quel jour du mois" — une paire
  // de dates précise par vérification. Ajuste librement.
  PREMIUM_SAMPLE_DEPART_DATE: "2026-10-05",
  PREMIUM_SAMPLE_RETURN_DATE: "2026-10-19"
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
 * À exécuter UNE SEULE FOIS manuellement depuis l'éditeur Apps Script.
 * Crée la feuille de log, initialise la config pilotable, installe le
 * trigger toutes les 30 min (48x/jour), et lance un premier check immédiat.
 */
function setup() {
  getOrCreateSheet_();
  getConfig_(); // initialise (ou migre) la config si besoin

  // Supprime TOUS les triggers du projet, y compris ceux laissés par
  // d'anciennes versions du script (ex. pollTelegram_) qui planteraient
  // en boucle puisque leur fonction n'existe plus.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("checkPrices").timeBased().everyMinutes(30).create();

  if (CONFIG_STATIC.PREMIUM_ENABLED) {
    ScriptApp.newTrigger("checkPremiumCabins").timeBased().everyDays(1).atHour(8).create();
  }

  checkPrices();
  Logger.log("Setup v" + SCRIPT_VERSION + " terminé : vérification automatique toutes les 30 minutes (éco).");
  if (CONFIG_STATIC.PREMIUM_ENABLED) {
    Logger.log("Module cabines premium activé : 1 vérification par jour, vers 8h.");
  }
  Logger.log("Pense à déployer en Web app puis lancer registerWebhook() pour activer les commandes Telegram.");
}

/**
 * À exécuter UNE SEULE FOIS après avoir déployé le script en "Web app"
 * (Déployer > Nouveau déploiement > Application Web) et rempli
 * CONFIG_STATIC.WEB_APP_URL avec l'URL obtenue. Relie ce déploiement à ton
 * bot Telegram pour que les commandes fonctionnent.
 */
function registerWebhook() {
  if (!CONFIG_STATIC.WEB_APP_URL || CONFIG_STATIC.WEB_APP_URL.indexOf("COLLE_ICI") === 0) {
    Logger.log("Renseigne d'abord CONFIG_STATIC.WEB_APP_URL avec l'URL de déploiement (voir guide).");
    return;
  }
  // drop_pending_updates : purge les vieux messages accumulés (utile si le
  // bot fonctionnait avant en polling ou si le webhook était cassé un temps).
  const url = "https://api.telegram.org/bot" + CONFIG_STATIC.TELEGRAM_BOT_TOKEN +
    "/setWebhook?drop_pending_updates=true&url=" + encodeURIComponent(CONFIG_STATIC.WEB_APP_URL);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log(resp.getContentText());
}

/** Arrête toutes les vérifications automatiques (supprime tous les triggers). */
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  Logger.log("Surveillance arrêtée (triggers supprimés).");
}

/** Point d'entrée appelé par Telegram à chaque message envoyé au bot. */
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);

    // Telegram ré-envoie le même update tant qu'il n'a pas reçu de réponse
    // rapide — on déduplique par update_id pour ne jamais traiter deux fois.
    if (update.update_id) {
      const last = Number(props_().getProperty("LAST_UPDATE_ID") || 0);
      if (update.update_id <= last) return ContentService.createTextOutput("ok");
      props_().setProperty("LAST_UPDATE_ID", String(update.update_id));
    }

    const message = update.message;
    if (message && message.text) {
      const chatId = String(message.chat.id);
      if (chatId === String(CONFIG_STATIC.TELEGRAM_CHAT_ID)) {
        handleCommand_(message.text.trim());
      }
      // messages venant d'un autre chat_id que le tien sont silencieusement ignorés
    }
  } catch (err) {
    Logger.log("Erreur doPost: " + err);
  }
  return ContentService.createTextOutput("ok");
}

function handleCommand_(text) {
  const parts = text.split(/\s+/);
  // Telegram ajoute parfois "@nomdubot" à la commande (ex: "/aide@mon_bot")
  // quand elle est tapée depuis la liste de suggestions — on l'ignore.
  const cmd = parts[0].toLowerCase().split("@")[0];
  const arg = parts.slice(1).join(" ").trim();

  // "ICN" tout court (3 lettres, sans /) = raccourci pour /demarrer ICN
  if (cmd.charAt(0) !== "/") {
    if (/^[a-z]{3}$/.test(cmd) && !arg) { cmdDemarrer_(cmd.toUpperCase()); return; }
    replyTelegram_("Commande inconnue. Envoie /aide pour la liste des commandes.");
    return;
  }

  const cfg = getConfig_();

  if (cmd === "/demarrer" || cmd === "/reprendre") {
    cmdDemarrer_(arg ? arg.toUpperCase() : null);

  } else if (cmd === "/pause") {
    cfg.paused = true;
    saveConfig_(cfg);
    replyTelegram_("⏸️ Vérifications automatiques en pause. Envoie /demarrer (ou /reprendre) pour les relancer.");

  } else if (cmd === "/seuil") {
    const val = parseInt(arg, 10);
    if (isNaN(val)) { replyTelegram_("Utilise : /seuil 600"); return; }
    cfg.alertBelow = val;
    saveConfig_(cfg);
    replyTelegram_("✅ Seuil d'alerte fixé à " + val + " " + cfg.currencies[0]);

  } else if (cmd === "/ajouter") {
    if (!arg) { replyTelegram_("Utilise : /ajouter FR (pays) ou /ajouter CDG (aéroport de départ)"); return; }
    const codeAdd = arg.toUpperCase();
    if (cfg.origins.indexOf(codeAdd) === -1) cfg.origins.push(codeAdd);
    saveConfig_(cfg);
    replyTelegram_("✅ Départ ajouté : " + codeAdd + "\n\n" + listText_(cfg));

  } else if (cmd === "/retirer") {
    if (!arg) { replyTelegram_("Utilise : /retirer ICN (destination) ou /retirer FR (départ)"); return; }
    const codeRemove = arg.toUpperCase();
    if (cfg.destinations.indexOf(codeRemove) !== -1) {
      if (cfg.destinations.length === 1) { replyTelegram_("⚠️ Impossible : il faut garder au moins une destination."); return; }
      cfg.destinations = cfg.destinations.filter(function (d) { return d !== codeRemove; });
      saveConfig_(cfg);
      replyTelegram_("🗑️ Destination retirée : " + codeRemove + "\n\n" + listText_(cfg));
    } else if (cfg.origins.indexOf(codeRemove) !== -1) {
      cfg.origins = cfg.origins.filter(function (o) { return o !== codeRemove; });
      saveConfig_(cfg);
      replyTelegram_("🗑️ Départ retiré : " + codeRemove + "\n\n" + listText_(cfg));
    } else {
      replyTelegram_("⚠️ " + codeRemove + " n'est ni dans les destinations ni dans les départs.\n\n" + listText_(cfg));
    }

  } else if (cmd === "/devises") {
    const curs = arg.toUpperCase().split(/[\s,]+/).filter(function (c) { return /^[A-Z]{3}$/.test(c); });
    if (curs.length === 0) { replyTelegram_("Utilise : /devises EUR USD (la 1ère est la devise du seuil)"); return; }
    cfg.currencies = curs;
    saveConfig_(cfg);
    replyTelegram_("💱 Devises suivies : " + curs.join(", ") + " (seuil en " + curs[0] + ")");

  } else if (cmd === "/liste") {
    replyTelegram_(listText_(cfg));

  } else if (cmd === "/status") {
    replyTelegram_(buildStatusText_(cfg));

  } else if (cmd === "/check") {
    replyTelegram_("🔍 Vérification en cours (" + cfg.destinations.join(", ") + " en " + cfg.currencies.join(", ") + ")…");
    runCheck_(cfg, cfg.destinations, true);

  } else if (cmd === "/aide" || cmd === "/help" || cmd === "/start") {
    replyTelegram_(helpText_());

  } else {
    replyTelegram_("Commande inconnue. Envoie /aide pour la liste des commandes.");
  }
}

/** /demarrer [DEST] : réactive la surveillance, et si DEST est fourni,
 * l'ajoute aux destinations suivies puis lance un check immédiat dessus. */
function cmdDemarrer_(dest) {
  const cfg = getConfig_();
  let msg = "";
  if (cfg.paused) {
    cfg.paused = false;
    msg += "▶️ Surveillance réactivée.\n";
  }
  if (dest) {
    if (cfg.destinations.indexOf(dest) === -1) {
      cfg.destinations.push(dest);
      msg += "🎯 Destination ajoutée : " + dest + "\n";
    } else {
      msg += "🎯 " + dest + " est déjà suivie.\n";
    }
  }
  saveConfig_(cfg);
  if (!msg) msg = "▶️ Surveillance déjà active.\n";
  replyTelegram_(msg + "\n" + listText_(cfg));
  if (dest) {
    replyTelegram_("🔍 Vérification immédiate de " + dest + "…");
    runCheck_(cfg, [dest], true);
  }
}

function listText_(cfg) {
  const expanded = expandOrigins_(cfg.origins);
  return "🎯 Destinations : " + cfg.destinations.join(", ") +
    "\n📍 Départs : " + cfg.origins.join(", ") +
    "\n(soit " + expanded.length + " aéroport(s) : " + expanded.join(", ") + ")" +
    "\n💱 Devises : " + cfg.currencies.join(", ") +
    "\n🎚 Seuil d'alerte : " + (cfg.alertBelow !== null ? cfg.alertBelow + " " + cfg.currencies[0] : "désactivé") +
    "\n" + (cfg.paused ? "⏸️ En pause" : "▶️ Actif (vérif. toutes les 30 min)") +
    "\n\n🤖 v" + SCRIPT_VERSION;
}

function buildStatusText_(cfg) {
  const lastResult = getJson_("LAST_RESULT", null);
  if (!lastResult || !lastResult.results || Object.keys(lastResult.results).length === 0) {
    return "Aucune vérification effectuée pour l'instant. Envoie /check pour en lancer une.\n\n🤖 v" + SCRIPT_VERSION;
  }
  const mins = getJson_("MINS", {});
  const lines = ["🕐 Dernière vérification : " + lastResult.checkedAt, ""];
  Object.keys(lastResult.results).sort().forEach(function (key) {
    const r = lastResult.results[key];
    const b = r.best;
    const dest = key.split("|")[0];
    const cur = key.split("|")[1];
    lines.push("🎯 " + dest + " (" + cur + ") — meilleur : " + b.origin + " à " + b.price + " " + cur +
      (key in mins ? " · record : " + mins[key] + " " + cur : "") +
      "\n   📅 " + fmtDate_(b.departure_at) + " → " + fmtDate_(b.return_at) +
      " · 🔁 " + b.transfers + " escale(s) · 🛫 " + b.airline);
  });
  lines.push("", "🤖 v" + SCRIPT_VERSION);
  return lines.join("\n");
}

function helpText_() {
  return "✈️ Commandes disponibles (v" + SCRIPT_VERSION + ") :\n\n" +
    "/demarrer ICN — ajoute/active une destination + check immédiat\n" +
    "ICN (tout court) — pareil que /demarrer ICN\n" +
    "/retirer ICN — retire une destination (ou une ville de départ)\n" +
    "/ajouter FR — ajoute un pays ou un aéroport de départ (ex: CDG)\n" +
    "/devises EUR USD — change les devises suivies (la 1ère porte le seuil)\n" +
    "/seuil 600 — change le seuil d'alerte\n" +
    "/pause — suspend les vérifications\n" +
    "/demarrer ou /reprendre — les relance\n" +
    "/check — force une vérification immédiate\n" +
    "/liste — affiche la config actuelle\n" +
    "/status — derniers meilleurs prix par destination/devise\n" +
    "/aide — ce message\n\n" +
    "🔔 Alertes : nouveau record, prix anormalement bas (probable erreur de " +
    "prix), ou passage sous le seuil — jamais deux fois pour le même prix.\n\n" +
    "🥂 Un module séparé vérifie aussi éco premium/affaires/première une " +
    "fois par jour (voir CONFIG_STATIC.PREMIUM_* dans le code).";
}

/** Fonction appelée automatiquement par le trigger toutes les 30 minutes. */
function checkPrices() {
  const cfg = getConfig_();
  if (cfg.paused) {
    Logger.log("Vérification ignorée : en pause.");
    return;
  }
  runCheck_(cfg, cfg.destinations, false);
}

/**
 * Cœur du tracker : interroge l'API pour chaque origine × destination ×
 * devise (par lots parallèles), journalise dans la Sheet, met à jour les
 * records et envoie les alertes pertinentes.
 *
 * N'écrit JAMAIS dans CONFIG : un /pause envoyé pendant un check ne peut
 * donc plus être écrasé (bug de la v1).
 *
 * verbose=true (via /check ou /demarrer) : envoie aussi un résumé Telegram
 * des meilleurs prix trouvés, même sans alerte.
 */
function runCheck_(cfg, destinations, verbose) {
  const expanded = expandOrigins_(cfg.origins);

  const requests = [];
  destinations.forEach(function (dest) {
    cfg.currencies.forEach(function (cur) {
      expanded.forEach(function (origin) {
        requests.push({ origin: origin, dest: dest, cur: cur, url: buildApiUrl_(origin, dest, cur) });
      });
    });
  });

  const responses = fetchAllBatched_(requests.map(function (r) { return r.url; }));

  // Meilleure offre par (destination, devise, origine), regroupée par destination+devise.
  const buckets = {};
  requests.forEach(function (r, i) {
    try {
      const offers = parseOffers_(responses[i]);
      if (offers.length > 0) {
        const key = r.dest + "|" + r.cur;
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(offers[0]);
      }
    } catch (e) {
      Logger.log("Erreur pour " + r.origin + "→" + r.dest + " (" + r.cur + ") : " + e);
    }
  });

  const keys = Object.keys(buckets);
  if (keys.length === 0) {
    Logger.log("Aucun résultat cette fois-ci.");
    if (verbose) replyTelegram_("😕 Aucun résultat trouvé cette fois-ci (cache API vide pour ces routes ?). Réessaie plus tard avec /check.");
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

  keys.sort().forEach(function (key) {
    const dest = key.split("|")[0];
    const cur = key.split("|")[1];
    const list = buckets[key];
    list.sort(function (a, b) { return a.price - b.price; });
    const best = list[0];

    list.forEach(function (o) {
      rows.push([now, o.origin, dest, cur, o.price, o.airline, o.departure_at, o.return_at, o.transfers, buildLink_(o)]);
    });

    const hist = recent[key] || [];
    const med = median_(hist);
    const prevMin = (key in mins) ? mins[key] : null;

    // Jamais d'alerte au tout premier relevé d'un couple destination/devise :
    // on enregistre la référence, les alertes commencent au relevé suivant.
    const isNewLow = prevMin !== null && best.price < prevMin;
    const isAnomaly = hist.length >= CONFIG_STATIC.ANOMALY_MIN_SAMPLES && med !== null &&
      best.price <= med * CONFIG_STATIC.ANOMALY_RATIO;
    const underThreshold = cur === cfg.currencies[0] && cfg.alertBelow !== null &&
      best.price <= cfg.alertBelow &&
      (!(key in alerted) || best.price < alerted[key]);

    if (prevMin === null || best.price < prevMin) mins[key] = best.price;
    hist.push(best.price);
    if (hist.length > CONFIG_STATIC.RECENT_WINDOW) hist.splice(0, hist.length - CONFIG_STATIC.RECENT_WINDOW);
    recent[key] = hist;

    lastResult.results[key] = { best: best, top: list.slice(0, 5) };

    summaryLines.push("🎯 " + dest + " (" + cur + ") : " + best.origin + " à " + best.price + " " + cur +
      " — " + fmtDate_(best.departure_at) + " → " + fmtDate_(best.return_at));

    if (!pausedNow && (isNewLow || isAnomaly || underThreshold)) {
      sendAlert_(best, dest, cur, list, prevMin, med, { isNewLow: isNewLow, isAnomaly: isAnomaly, underThreshold: underThreshold });
      alerted[key] = best.price;
    }
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
    replyTelegram_("✅ Vérification terminée :\n\n" + summaryLines.join("\n"));
  }
}

function sendAlert_(best, dest, cur, list, prevMin, med, reasons) {
  let title;
  if (reasons.isAnomaly) title = "🚨 Prix anormalement bas — probable erreur de prix !";
  else if (reasons.isNewLow) title = "🔻 Nouveau prix le plus bas !";
  else title = "🎯 Prix sous ton seuil !";

  const top3 = list.slice(0, 3)
    .map(function (o, i) { return (i + 1) + ". " + o.origin + " — " + o.price + " " + cur; })
    .join("\n");

  const msg = title + "\n\n" +
    "🏆 " + best.origin + " → " + dest + "\n" +
    "💰 " + best.price + " " + cur +
    (prevMin !== null ? " (ancien record : " + prevMin + " " + cur + ")" : "") +
    (reasons.isAnomaly && med !== null ? "\n📉 " + Math.round(100 - best.price / med * 100) + "% sous la médiane récente (" + Math.round(med) + " " + cur + ")" : "") +
    "\n📅 " + fmtDate_(best.departure_at) + " → " + fmtDate_(best.return_at) + "\n" +
    "🔁 " + best.transfers + " escale(s)\n" +
    "🛫 " + best.airline +
    "\n\n📊 Top villes de départ :\n" + top3 +
    "\n\n🔗 " + buildLink_(best) +
    "\n\n⚠️ Prix issu du cache API (~48h) — vérifie avant d'acheter.";

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

function buildApiUrl_(origin, destination, currency) {
  const params = {
    origin: origin,
    destination: destination,
    departure_at: CONFIG_STATIC.DEPARTURE_MONTH,
    return_at: CONFIG_STATIC.RETURN_MONTH,
    one_way: "false",
    direct: "false",
    sorting: "price",
    unique: "false",
    currency: currency.toLowerCase(),
    limit: "30",
    token: CONFIG_STATIC.TRAVELPAYOUTS_TOKEN
  };
  return "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + toQuery_(params);
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

function parseOffers_(resp) {
  const json = JSON.parse(resp.getContentText());
  if (!json.success || !json.data) return [];

  return json.data
    .filter(withinTripDuration_)
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

function withinTripDuration_(o) {
  if (!o.return_at || !o.departure_at) return true;
  const d1 = new Date(o.departure_at);
  const d2 = new Date(o.return_at);
  const days = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return days >= CONFIG_STATIC.TRIP_DURATION_MIN && days <= CONFIG_STATIC.TRIP_DURATION_MAX;
}

function median_(values) {
  if (!values || values.length === 0) return null;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function fmtDate_(iso) {
  return iso ? String(iso).substring(0, 10) : "?";
}

function replyTelegram_(text) {
  const url = "https://api.telegram.org/bot" + CONFIG_STATIC.TELEGRAM_BOT_TOKEN + "/sendMessage";
  UrlFetchApp.fetch(url, {
    method: "post",
    payload: { chat_id: CONFIG_STATIC.TELEGRAM_CHAT_ID, text: text },
    muteHttpExceptions: true
  });
}

function buildLink_(o) {
  return "https://www.aviasales.com/search/" + o.link;
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
 * volontairement peu fréquent (1x/jour), et TOUT est protégé par des
 * try/catch — si Google bloque ou change sa page, ce module échoue en
 * silence et le suivi éco principal continue sans aucune interruption.
 */
function checkPremiumCabins() {
  if (!CONFIG_STATIC.PREMIUM_ENABLED) return;

  try {
    const cfg = getConfig_();
    if (cfg.paused) {
      Logger.log("Module premium ignoré : en pause.");
      return;
    }

    const cur = cfg.currencies[0];
    const origins = expandOrigins_(cfg.origins).slice(0, CONFIG_STATIC.PREMIUM_MAX_ORIGINS);
    const sheet = getOrCreatePremiumSheet_();
    const now = new Date();
    const premiumMins = getJson_("PREMIUM_MINS", {});
    const results = []; // { cabin, dest, price, origin, airlines, stops }

    cfg.destinations.forEach(function (dest) {
      CONFIG_STATIC.PREMIUM_CABINS.forEach(function (cabin) {
        origins.forEach(function (origin) {
          try {
            const offers = fetchGoogleFlightsOffers_(origin, dest, cabin, cur);
            if (offers.length > 0) {
              const best = offers[0];
              results.push(best);
              sheet.appendRow([
                now, origin, dest, cabin, best.price, cur,
                best.airlines.join(" + "), best.stops,
                CONFIG_STATIC.PREMIUM_SAMPLE_DEPART_DATE, CONFIG_STATIC.PREMIUM_SAMPLE_RETURN_DATE
              ]);
            }
          } catch (e) {
            Logger.log("Module premium — échec pour " + origin + "→" + dest + "/" + cabin + " : " + e);
          }
          Utilities.sleep(300);
        });
      });
    });

    if (results.length === 0) {
      Logger.log("Module premium : aucun résultat cette fois-ci.");
      return;
    }

    // Alerte sur les nouveaux records par (cabine, destination) — jamais au
    // tout premier relevé (référence seulement).
    cfg.destinations.forEach(function (dest) {
      CONFIG_STATIC.PREMIUM_CABINS.forEach(function (cabin) {
        const forKey = results.filter(function (r) { return r.cabin === cabin && r.destination === dest; });
        if (forKey.length === 0) return;
        forKey.sort(function (a, b) { return a.price - b.price; });
        const best = forKey[0];
        const key = cabin + "|" + dest + "|" + cur;
        const prevMin = (key in premiumMins) ? premiumMins[key] : null;
        if (prevMin === null || best.price < prevMin) {
          premiumMins[key] = best.price;
          if (prevMin !== null) sendPremiumAlert_(best, prevMin, cur);
        }
      });
    });
    setJson_("PREMIUM_MINS", premiumMins);
  } catch (e) {
    // Filet de sécurité global : quoi qu'il arrive, ce module ne doit
    // jamais faire planter le trigger ni affecter le suivi éco.
    Logger.log("Module premium — erreur générale, ignorée : " + e);
  }
}

function fetchGoogleFlightsOffers_(origin, destination, cabin, currency) {
  const tfs = buildTfs_(
    [
      { date: CONFIG_STATIC.PREMIUM_SAMPLE_DEPART_DATE, from: origin, to: destination },
      { date: CONFIG_STATIC.PREMIUM_SAMPLE_RETURN_DATE, from: destination, to: origin }
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
  if (!scriptMatch) throw new Error("structure ds:1 introuvable (Google a peut-être changé sa page)");

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
  const cabinLabel = { "premium-economy": "Éco premium", "business": "Affaires", "first": "Première" }[best.cabin] || best.cabin;
  const msg = "🥂 Nouveau prix le plus bas — " + cabinLabel + " !\n\n" +
    "✈️ " + best.origin + " → " + best.destination + "\n" +
    "💰 " + best.price + " " + cur + " (aller-retour)\n" +
    "🔁 " + best.stops + " escale(s)\n" +
    "🛫 " + best.airlines.join(" + ") +
    (previousMin !== null ? "\n(ancien minimum : " + previousMin + " " + cur + ")" : "") +
    "\n\n⚠️ Prix issu d'un scraping non officiel de Google Flights — vérifie sur place avant de réserver.";
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
 * CONFIG      : écrit uniquement par les commandes Telegram
 * MINS        : records par "destination|devise" (écrit par runCheck_)
 * ALERTED     : dernier prix alerté par "destination|devise" (anti-spam)
 * RECENT      : derniers relevés par "destination|devise" (détection anomalie)
 * LAST_RESULT : derniers meilleurs prix (pour /status)
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

function getConfig_() {
  let cfg = getJson_("CONFIG", null);
  if (!cfg) {
    // Migration depuis la v1 (clé STATE unique) si elle existe.
    const old = getJson_("STATE", null);
    cfg = {
      destinations: CONFIG_STATIC.DEFAULT_DESTINATIONS.slice(),
      origins: old && old.origins ? old.origins : CONFIG_STATIC.DEFAULT_ORIGINS.slice(),
      currencies: CONFIG_STATIC.DEFAULT_CURRENCIES.slice(),
      alertBelow: old && old.alertBelow !== undefined ? old.alertBelow : CONFIG_STATIC.DEFAULT_ALERT_BELOW,
      paused: old ? !!old.paused : false
    };
    saveConfig_(cfg);
    if (old) props_().deleteProperty("STATE");
  }
  return cfg;
}

function saveConfig_(cfg) {
  setJson_("CONFIG", cfg);
}
