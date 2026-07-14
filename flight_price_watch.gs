/**
 * FLIGHT PRICE WATCH — Corée du Sud
 *
 * Compare les prix de vols vers Séoul depuis les villes/aéroports européens
 * de ton choix (un code pays comme "FR" s'étend automatiquement vers ses
 * principaux aéroports, un code aéroport comme "CDG" cible précisément),
 * enregistre l'historique dans une Google Sheet, et alerte sur Telegram dès
 * qu'un nouveau prix plancher — toutes villes confondues — apparaît (ou
 * qu'un prix passe sous ton seuil).
 *
 * Tourne 100% côté serveur Google (Apps Script) : pas besoin de garder ton
 * ordinateur, ton navigateur ou une app ouverte. Hébergement gratuit.
 *
 * Pilotage à distance via commandes Telegram (voir handleCommand_ plus bas) :
 *   /seuil 600        → change le prix qui déclenche une alerte immédiate
 *   /ajouter FR        → ajoute un pays (étendu auto) ou un aéroport précis
 *   /retirer FR        → retire une entrée
 *   /liste              → affiche la config actuelle
 *   /pause               → suspend les vérifications automatiques
 *   /reprendre           → les relance
 *   /status               → dernier meilleur prix trouvé
 *   /aide                  → rappel des commandes
 *
 * Source de données : Travelpayouts / Aviasales Data API (gratuite, cache
 * jusqu'à ~48h basé sur les recherches réelles des utilisateurs Aviasales).
 * => Toujours revérifier le prix exact avant d'acheter.
 *
 * IMPORTANT : testé en direct, un code pays sur cette API ne renvoie PAS les
 * prix de tous les aéroports du pays — il est résolu vers une seule ville
 * "dominante" (ex: DE → seulement Francfort). C'est pour ça que ce script
 * étend lui-même chaque code pays vers une liste d'aéroports connus
 * (COUNTRY_AIRPORTS ci-dessous) plutôt que de compter sur l'API pour le faire.
 *
 * MODULE COMPLÉMENTAIRE — cabines premium (checkPremiumCabins) :
 * Travelpayouts ne sait pas filtrer par classe (éco/éco premium/affaires/
 * première). Ce module interroge directement Google Flights (même requête
 * que fait ton navigateur, avec un cookie de consentement pour éviter la
 * page cookies) pour un petit nombre de villes et de dates précises, une
 * fois par jour seulement — volontairement peu fréquent pour rester discret.
 * C'est un scraping non officiel : ça peut casser sans prévenir si Google
 * change sa page. Chaque appel est protégé par un try/catch qui échoue en
 * silence — si ce module tombe en panne, le suivi éco principal (fiable,
 * basé sur Travelpayouts) continue de tourner normalement, sans interruption.
 */

/************ CONFIGURATION STATIQUE — à personnaliser une fois ************/
const CONFIG_STATIC = {
  TRAVELPAYOUTS_TOKEN: "COLLE_TON_TOKEN_TRAVELPAYOUTS_ICI",
  TELEGRAM_BOT_TOKEN: "COLLE_TON_TOKEN_TELEGRAM_ICI",
  TELEGRAM_CHAT_ID: "COLLE_TON_CHAT_ID_ICI",

  // À remplir APRÈS avoir déployé le script en "Web app" (voir guide) —
  // nécessaire uniquement pour que /registerWebhook fonctionne.
  WEB_APP_URL: "COLLE_ICI_L_URL_DE_DEPLOIEMENT_/exec",

  // "SEL" couvre Séoul-Incheon (ICN) + Séoul-Gimpo (GMP). Mets "ICN" pour
  // ne cibler qu'Incheon.
  DESTINATION: "SEL",

  DEPARTURE_MONTH: "2026-10", // mois de départ surveillé (YYYY-MM)
  RETURN_MONTH: "2026-10",    // mois de retour surveillé (YYYY-MM)

  TRIP_DURATION_MIN: 7,   // durée de séjour mini (jours) — filtre les A/R trop courts
  TRIP_DURATION_MAX: 21,  // durée de séjour maxi (jours)

  CURRENCY: "eur",

  SHEET_NAME: "Historique prix Corée du Sud",

  // Config de DÉPART au tout premier lancement (setup()). Ensuite, tout se
  // pilote via les commandes Telegram — modifier ces valeurs plus tard n'a
  // aucun effet, seul l'état stocké dans PropertiesService compte.
  DEFAULT_ORIGINS: ["FR", "BE", "NL", "GB", "DE", "ES", "IT", "PT", "CH"],
  DEFAULT_ALERT_BELOW: 650,

  // --- Module cabines premium (checkPremiumCabins) ---
  PREMIUM_ENABLED: true,
  PREMIUM_CABINS: ["premium-economy", "business", "first"],
  PREMIUM_MAX_ORIGINS: 5, // limite le nombre de villes interrogées (volume = risque de blocage)
  // Dates fixes utilisées pour ce module (Google Flights n'a pas de mode
  // "n'importe quel jour du mois" comme Travelpayouts — une paire de dates
  // précise par vérification). Ajuste librement.
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
  getState_(); // initialise l'état s'il n'existe pas encore

  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === "checkPrices" || fn === "checkPremiumCabins") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("checkPrices").timeBased().everyMinutes(30).create();

  if (CONFIG_STATIC.PREMIUM_ENABLED) {
    ScriptApp.newTrigger("checkPremiumCabins").timeBased().everyDays(1).atHour(8).create();
  }

  checkPrices();
  Logger.log("Setup terminé : vérification automatique toutes les 30 minutes (éco).");
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
  const url = "https://api.telegram.org/bot" + CONFIG_STATIC.TELEGRAM_BOT_TOKEN +
    "/setWebhook?url=" + encodeURIComponent(CONFIG_STATIC.WEB_APP_URL);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log(resp.getContentText());
}

/** Arrête toutes les vérifications automatiques (supprime les triggers). */
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === "checkPrices" || fn === "checkPremiumCabins") ScriptApp.deleteTrigger(t);
  });
  Logger.log("Surveillance arrêtée (triggers supprimés).");
}

/** Point d'entrée appelé par Telegram à chaque message envoyé au bot. */
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
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
  const state = getState_();

  if (cmd === "/seuil") {
    const val = parseInt(arg, 10);
    if (isNaN(val)) { replyTelegram_("Utilise : /seuil 600"); return; }
    state.alertBelow = val;
    saveState_(state);
    replyTelegram_("✅ Seuil d'alerte fixé à " + val + " " + CONFIG_STATIC.CURRENCY.toUpperCase());

  } else if (cmd === "/ajouter") {
    if (!arg) { replyTelegram_("Utilise : /ajouter FR (pays) ou /ajouter CDG (aéroport)"); return; }
    const codeAdd = arg.toUpperCase();
    if (state.origins.indexOf(codeAdd) === -1) state.origins.push(codeAdd);
    saveState_(state);
    replyTelegram_("✅ Ajouté : " + codeAdd + "\n\n" + listOriginsText_(state));

  } else if (cmd === "/retirer") {
    if (!arg) { replyTelegram_("Utilise : /retirer FR"); return; }
    const codeRemove = arg.toUpperCase();
    state.origins = state.origins.filter(function (o) { return o !== codeRemove; });
    saveState_(state);
    replyTelegram_("🗑️ Retiré : " + codeRemove + "\n\n" + listOriginsText_(state));

  } else if (cmd === "/liste") {
    replyTelegram_(listOriginsText_(state));

  } else if (cmd === "/pause") {
    state.paused = true;
    saveState_(state);
    replyTelegram_("⏸️ Vérifications automatiques en pause. Envoie /reprendre pour les relancer.");

  } else if (cmd === "/reprendre") {
    state.paused = false;
    saveState_(state);
    replyTelegram_("▶️ Vérifications automatiques reprises.");

  } else if (cmd === "/status") {
    replyTelegram_(buildStatusText_(state));

  } else if (cmd === "/aide" || cmd === "/help" || cmd === "/start") {
    replyTelegram_(helpText_());

  } else {
    replyTelegram_("Commande inconnue. Envoie /aide pour la liste des commandes.");
  }
}

function listOriginsText_(state) {
  const expanded = expandOrigins_(state.origins);
  return "📍 Entrées surveillées : " + state.origins.join(", ") +
    "\n(soit " + expanded.length + " aéroport(s) au total : " + expanded.join(", ") + ")" +
    "\n🎯 Seuil d'alerte : " + (state.alertBelow !== null ? state.alertBelow + " " + CONFIG_STATIC.CURRENCY.toUpperCase() : "désactivé") +
    "\n" + (state.paused ? "⏸️ En pause" : "▶️ Actif (vérif. toutes les 30 min)");
}

function buildStatusText_(state) {
  if (!state.lastResult) return "Aucune vérification effectuée pour l'instant.";
  const r = state.lastResult;
  const b = r.best;
  const top = r.top.map(function (o, i) {
    return (i + 1) + ". " + o.origin + " — " + o.price + " " + CONFIG_STATIC.CURRENCY.toUpperCase();
  }).join("\n");
  return "🕐 Dernière vérification : " + r.checkedAt +
    "\n🏆 Meilleur prix : " + b.origin + " → " + CONFIG_STATIC.DESTINATION + " — " + b.price + " " + CONFIG_STATIC.CURRENCY.toUpperCase() +
    "\n📅 " + (b.departure_at ? b.departure_at.substring(0, 10) : "?") + " → " + (b.return_at ? b.return_at.substring(0, 10) : "?") +
    "\n\n📊 Top villes :\n" + top;
}

function helpText_() {
  return "✈️ Commandes disponibles :\n\n" +
    "/seuil 600 — change le seuil d'alerte (EUR)\n" +
    "/ajouter FR — ajoute un pays ou un aéroport (ex: CDG)\n" +
    "/retirer FR — retire une entrée\n" +
    "/liste — affiche la config actuelle\n" +
    "/pause — suspend les vérifications\n" +
    "/reprendre — les relance\n" +
    "/status — dernier meilleur prix trouvé\n" +
    "/aide — ce message\n\n" +
    "🥂 Un module séparé vérifie aussi éco premium/affaires/première une " +
    "fois par jour (voir CONFIG_STATIC.PREMIUM_* dans le code) — pas encore " +
    "pilotable par commande, à ajuster directement dans le script si besoin.";
}

/** Fonction appelée automatiquement par le trigger toutes les 30 minutes. */
function checkPrices() {
  const state = getState_();
  if (state.paused) {
    Logger.log("Vérification ignorée : en pause.");
    return;
  }

  const sheet = getOrCreateSheet_();
  const expanded = expandOrigins_(state.origins);
  const bestPerAirport = [];

  expanded.forEach(function (origin, i) {
    try {
      const offers = fetchOffers_(origin, CONFIG_STATIC.DESTINATION);
      if (offers.length > 0) bestPerAirport.push(offers[0]);
    } catch (e) {
      Logger.log("Erreur pour " + origin + " : " + e);
    }
    if (i < expanded.length - 1) Utilities.sleep(200);
  });

  if (bestPerAirport.length === 0) {
    Logger.log("Aucun résultat cette fois-ci.");
    return;
  }

  bestPerAirport.sort(function (a, b) { return a.price - b.price; });
  const best = bestPerAirport[0]; // meilleur prix toutes villes confondues

  const previousMin = getPreviousMin_(sheet, CONFIG_STATIC.DESTINATION);

  const now = new Date();
  bestPerAirport.forEach(function (o) {
    sheet.appendRow([
      now, o.origin, CONFIG_STATIC.DESTINATION, o.price, CONFIG_STATIC.CURRENCY, o.airline,
      o.departure_at, o.return_at, o.transfers, buildLink_(o)
    ]);
  });

  state.lastResult = {
    checkedAt: now.toISOString(),
    best: best,
    top: bestPerAirport.slice(0, 5)
  };
  saveState_(state);

  const isNewLow = previousMin === null || best.price < previousMin;
  const isUnderThreshold = state.alertBelow !== null && best.price <= state.alertBelow;

  if (isNewLow || isUnderThreshold) {
    sendTelegramAlert_(best, bestPerAirport, previousMin, isNewLow, isUnderThreshold);
  }
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

function fetchOffers_(origin, destination) {
  const params = {
    origin: origin,
    destination: destination,
    departure_at: CONFIG_STATIC.DEPARTURE_MONTH,
    return_at: CONFIG_STATIC.RETURN_MONTH,
    one_way: "false",
    direct: "false",
    sorting: "price",
    unique: "false",
    currency: CONFIG_STATIC.CURRENCY,
    limit: "30",
    token: CONFIG_STATIC.TRAVELPAYOUTS_TOKEN
  };
  const url = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + toQuery_(params);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
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
    });
}

function withinTripDuration_(o) {
  if (!o.return_at || !o.departure_at) return true;
  const d1 = new Date(o.departure_at);
  const d2 = new Date(o.return_at);
  const days = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return days >= CONFIG_STATIC.TRIP_DURATION_MIN && days <= CONFIG_STATIC.TRIP_DURATION_MAX;
}

// Minimum global déjà observé pour cette destination, toutes villes de
// départ confondues (c'est LE chiffre qui compte pour repérer une bonne affaire).
function getPreviousMin_(sheet, destination) {
  const data = sheet.getDataRange().getValues();
  let min = null;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[2] === destination) {
      const price = row[3];
      if (min === null || price < min) min = price;
    }
  }
  return min;
}

function sendTelegramAlert_(best, bestPerOrigin, previousMin, isNewLow, isUnderThreshold) {
  const title = isNewLow ? "🔻 Nouveau prix le plus bas (Europe) !" : "🎯 Prix sous ton seuil !";
  const dep = best.departure_at ? best.departure_at.substring(0, 10) : "?";
  const ret = best.return_at ? best.return_at.substring(0, 10) : "?";

  const top3 = bestPerOrigin.slice(0, 3)
    .map(function (o, i) { return (i + 1) + ". " + o.origin + " — " + o.price + " " + CONFIG_STATIC.CURRENCY.toUpperCase(); })
    .join("\n");

  const msg = title + "\n\n" +
    "🏆 Meilleure option : " + best.origin + " → " + CONFIG_STATIC.DESTINATION + "\n" +
    "💶 " + best.price + " " + CONFIG_STATIC.CURRENCY.toUpperCase() + "\n" +
    "📅 " + dep + " → " + ret + "\n" +
    "🔁 " + best.transfers + " escale(s)\n" +
    "🛫 " + best.airline +
    (previousMin !== null ? "\n(ancien minimum : " + previousMin + " " + CONFIG_STATIC.CURRENCY.toUpperCase() + ")" : "") +
    "\n\n📊 Top villes de départ :\n" + top3 +
    "\n\n🔗 " + buildLink_(best);

  replyTelegram_(msg);
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
    const state = getState_();
    if (state.paused) {
      Logger.log("Module premium ignoré : en pause.");
      return;
    }

    const origins = expandOrigins_(state.origins).slice(0, CONFIG_STATIC.PREMIUM_MAX_ORIGINS);
    const sheet = getOrCreatePremiumSheet_();
    const now = new Date();
    const results = []; // { cabin, price, origin, airlines, stops }

    CONFIG_STATIC.PREMIUM_CABINS.forEach(function (cabin) {
      origins.forEach(function (origin) {
        try {
          const offers = fetchGoogleFlightsOffers_(origin, CONFIG_STATIC.DESTINATION, cabin);
          if (offers.length > 0) {
            const best = offers[0];
            results.push(best);
            sheet.appendRow([
              now, origin, CONFIG_STATIC.DESTINATION, cabin, best.price, CONFIG_STATIC.CURRENCY,
              best.airlines.join(" + "), best.stops,
              CONFIG_STATIC.PREMIUM_SAMPLE_DEPART_DATE, CONFIG_STATIC.PREMIUM_SAMPLE_RETURN_DATE
            ]);
          }
        } catch (e) {
          Logger.log("Module premium — échec pour " + origin + "/" + cabin + " : " + e);
        }
        Utilities.sleep(300);
      });
    });

    if (results.length === 0) {
      Logger.log("Module premium : aucun résultat cette fois-ci.");
      return;
    }

    // Regroupe par cabine et alerte sur les nouveaux records de chaque cabine.
    CONFIG_STATIC.PREMIUM_CABINS.forEach(function (cabin) {
      const forCabin = results.filter(function (r) { return r.cabin === cabin; });
      if (forCabin.length === 0) return;
      forCabin.sort(function (a, b) { return a.price - b.price; });
      const best = forCabin[0];
      const previousMin = getPremiumPreviousMin_(sheet, cabin);
      if (previousMin === null || best.price < previousMin) {
        sendPremiumAlert_(best, previousMin);
      }
    });
  } catch (e) {
    // Filet de sécurité global : quoi qu'il arrive, ce module ne doit
    // jamais faire planter le trigger ni affecter le suivi éco.
    Logger.log("Module premium — erreur générale, ignorée : " + e);
  }
}

function fetchGoogleFlightsOffers_(origin, destination, cabin) {
  const tfs = buildTfs_(
    [
      { date: CONFIG_STATIC.PREMIUM_SAMPLE_DEPART_DATE, from: origin, to: destination },
      { date: CONFIG_STATIC.PREMIUM_SAMPLE_RETURN_DATE, from: destination, to: origin }
    ],
    cabin, "round-trip", 1
  );

  const url = "https://www.google.com/travel/flights?tfs=" + encodeURIComponent(tfs) +
    "&hl=en&curr=" + CONFIG_STATIC.CURRENCY.toUpperCase();

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

function getPremiumPreviousMin_(sheet, cabin) {
  const data = sheet.getDataRange().getValues();
  let min = null;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[3] === cabin) {
      const price = row[4];
      if (min === null || price < min) min = price;
    }
  }
  return min;
}

function sendPremiumAlert_(best, previousMin) {
  const cabinLabel = { "premium-economy": "Éco premium", "business": "Affaires", "first": "Première" }[best.cabin] || best.cabin;
  const msg = "🥂 Nouveau prix le plus bas — " + cabinLabel + " !\n\n" +
    "✈️ " + best.origin + " → " + CONFIG_STATIC.DESTINATION + "\n" +
    "💶 " + best.price + " " + CONFIG_STATIC.CURRENCY.toUpperCase() + " (aller-retour)\n" +
    "🔁 " + best.stops + " escale(s)\n" +
    "🛫 " + best.airlines.join(" + ") +
    (previousMin !== null ? "\n(ancien minimum : " + previousMin + " " + CONFIG_STATIC.CURRENCY.toUpperCase() + ")" : "") +
    "\n\n⚠️ Prix issu d'un scraping non officiel de Google Flights — vérifie sur place avant de réserver.";
  replyTelegram_(msg);
}

function getOrCreatePremiumSheet_() {
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

function getOrCreateSheet_() {
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
  let sheet = ss.getSheetByName("Log");
  if (!sheet) {
    sheet = ss.insertSheet("Log");
    sheet.appendRow([
      "Date vérification", "Origine", "Destination", "Prix", "Devise",
      "Compagnie", "Départ", "Retour", "Escales", "Lien"
    ]);
  }
  return sheet;
}

/** État pilotable via Telegram, persisté entre les exécutions (PropertiesService). */
function getState_() {
  const raw = PropertiesService.getScriptProperties().getProperty("STATE");
  if (raw) return JSON.parse(raw);

  const initial = {
    origins: CONFIG_STATIC.DEFAULT_ORIGINS.slice(),
    alertBelow: CONFIG_STATIC.DEFAULT_ALERT_BELOW,
    paused: false,
    lastResult: null
  };
  saveState_(initial);
  return initial;
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty("STATE", JSON.stringify(state));
}
