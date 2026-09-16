/**
 * Source du beacon analytics (slice 17/37) — **un IIFE minuscule, zéro
 * dépendance, zéro SDK tiers**. Servi en tant que fichier statique
 * (`/api/analytics/beacon.js`, route prérendue au build) : le JS ajouté au
 * bundle public du Project est strictement nul, le beacon lui-même pèse
 * ~1,4 Ko brut (mesuré par test unitaire).
 *
 * Comportements (politique serveur en dernier ressort — le beacon est
 * un capteur **muet**, jamais une autorité : bots, préfetch, chemins
 * exclus et activations sont jugés côté serveur) :
 * - DNT / GPC côté navigateur → aucune requête du tout ;
 * - session éphémère en **sessionStorage** (par onglet, supprimée à la
 *   fermeture — jamais un cookie, jamais de persistance cross-site) ;
 * - page prerendering → mesure à l'**activation** (`prerenderingchange`),
 *   pas au crawl de prérendu ;
 * - transport : `navigator.sendBeacon`, repli `fetch keepalive` ;
 * - CTA opt-in : clic sur `[data-kz-cta]` → `cta_click`.
 *
 * La fonction est pure (paramètre `enabled`) : désactivée, la route sert
 * un stub vide — le Project qui laisse le tag en place ne mesure rien.
 */
export function beaconModuleSource(enabled: boolean): string {
  if (!enabled) {
    return '/* Kreiz analytics : collecte désactivée par la configuration du projet. */\n';
  }
  return `"use strict";
(function () {
  var COLLECT = ${JSON.stringify(BEACON_COLLECT_PATH)};
  if (navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true) { return; }
  var KEY = "kreiz.analytics.session";
  var session;
  try {
    session = sessionStorage.getItem(KEY);
    if (!session) {
      session = crypto.randomUUID();
      sessionStorage.setItem(KEY, session);
    }
  } catch (e) {
    try { session = crypto.randomUUID(); } catch (e2) { return; }
  }
  function send(payload) {
    var body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(COLLECT, new Blob([body], { type: "application/json" }));
    } else {
      fetch(COLLECT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body,
        keepalive: true,
        credentials: "omit"
      }).catch(function () {});
    }
  }
  function utm() {
    var out = {};
    var query = new URLSearchParams(location.search);
    var names = ["source", "medium", "campaign", "content", "term"];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var value = (query.get("utm_" + name) || "").trim().slice(0, 128);
      if (value) { out[name] = value; }
    }
    return out;
  }
  function trackPage() {
    send({
      type: "pv",
      path: location.pathname,
      ref: document.referrer || "",
      session: session,
      utm: utm(),
      locale: navigator.language || ""
    });
  }
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", trackPage, { once: true });
  } else {
    trackPage();
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    var el = target && target.closest ? target.closest("[data-kz-cta]") : null;
    if (!el) { return; }
    send({
      type: "cta",
      path: location.pathname,
      session: session,
      id: (el.getAttribute("data-kz-cta") || "").slice(0, 64)
    });
  }, { passive: true });
})();
`;
}

/** Chemin du fichier beacon — constante publique (exportée par @kreiz/core/analytics). */
export { PUBLIC_ANALYTICS_BEACON_PATTERN as ANALYTICS_BEACON_PATH } from '../http/admin-routes.js';
import { PUBLIC_ANALYTICS_BEACON_PATH, PUBLIC_ANALYTICS_EVENT_PATTERN } from '../http/admin-routes.js';

const BEACON_COLLECT_PATH = PUBLIC_ANALYTICS_EVENT_PATTERN;

/** Tag HTML complet du beacon — à insérer avec `set:html` dans les pages publiques. */
export function analyticsBeaconScript(): string {
  return `<script src="${PUBLIC_ANALYTICS_BEACON_PATH}" defer></script>`;
}
