import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_BODY_MAX_BYTES,
  ANALYTICS_DEDUP_WINDOW_MS,
  analyticsDedupKey,
  classifyReferrer,
  deviceClassFromUserAgent,
  hasExplicitPrivacySignal,
  isBotUserAgent,
  isExcludedAnalyticsPath,
  isPrefetchRequest,
  normalizeAnalyticsLocale,
  normalizeAnalyticsPath,
  normalizeAnalyticsSession,
  normalizeCtaId,
  normalizeReferrerDomain,
  normalizeUtmValue,
  splitContentPath,
  utcDayKey,
} from '../src/domain/analytics/policy';
import { parseClientEvent } from '../src/domain/analytics/collect';

/**
 * Tests du domaine analytics (slice 8) — politique privacy-first,
 * normalisation stricte et scénarios hostiles de la section 30 de la
 * mission. Aucun payload hostile ne doit produire de donnée non bornée :
 * chaque champ est soit normalisé, soit réduit à `null`, soit rejeté.
 */

const ctx = { requestHost: 'site.example', internalDomains: ['www-miroir.example'] };

describe('normalizeAnalyticsPath — query stripping et bornes', () => {
  it('conserve le pathname seul, sans query ni fragment', () => {
    expect(normalizeAnalyticsPath('/articles/mon-slug?utm_source=x#ancre')).toBe('/articles/mon-slug');
    expect(normalizeAnalyticsPath('/')).toBe('/');
  });

  it('rejette les chemins non commençant par « / » (URL absolue, protocole-relatif, vide)', () => {
    expect(normalizeAnalyticsPath('https://evil.example/steal')).toBeNull();
    expect(normalizeAnalyticsPath('//evil.example')).toBeNull();
    expect(normalizeAnalyticsPath('')).toBeNull();
    expect(normalizeAnalyticsPath('articles/foo')).toBeNull();
  });

  it('rejette CR/LF et caractères de contrôle (injection d’en-tête, log forging)', () => {
    expect(normalizeAnalyticsPath('/a\r\nX-Injected: 1')).toBeNull();
    expect(normalizeAnalyticsPath('/a\x00b')).toBeNull();
    expect(normalizeAnalyticsPath('/a\u2028b')).toBeNull();
  });

  it('borne la longueur (512)', () => {
    expect(normalizeAnalyticsPath(`/${'a'.repeat(511)}`)).toBe(`/${'a'.repeat(511)}`);
    expect(normalizeAnalyticsPath(`/${'a'.repeat(600)}`)).toBeNull();
  });

  it('rejette les non-chaînes', () => {
    expect(normalizeAnalyticsPath(null)).toBeNull();
    expect(normalizeAnalyticsPath(undefined)).toBeNull();
    expect(normalizeAnalyticsPath(42)).toBeNull();
    expect(normalizeAnalyticsPath({ path: '/' })).toBeNull();
  });
});

describe('referrer — réduction au domaine et classification', () => {
  it('réduit l’URL complète au host minuscule (jamais de query stockée)', () => {
    expect(normalizeReferrerDomain('https://Google.com/search?q=données+privées&id=secret')).toBe(
      'google.com',
    );
  });

  it('rejette les entrées non URL et schemes exotiques ; borne le domaine stocké', () => {
    expect(normalizeReferrerDomain('pas une url')).toBeNull();
    expect(normalizeReferrerDomain('data:text/html,<script>')).toBeNull();
    expect(normalizeReferrerDomain('app://interne')).toBeNull();
    // Une URL à chemin géant est neutralisée par la réduction au domaine
    // (seul le host borné est stocké) ; un host géant, lui, est refusé.
    expect(normalizeReferrerDomain(`https://x.example/${'a'.repeat(3000)}`)).toBe('x.example');
    expect(normalizeReferrerDomain(`https://${'a'.repeat(300)}.example/`)).toBeNull();
    expect(normalizeReferrerDomain('')).toBeNull();
  });

  it('classe internal / external / direct', () => {
    expect(classifyReferrer('site.example', { requestHost: 'site.example' })).toBe('internal');
    expect(classifyReferrer('www-miroir.example', { requestHost: 'site.example', internalDomains: ctx.internalDomains })).toBe('internal');
    expect(classifyReferrer('autre.example', { requestHost: 'site.example' })).toBe('external');
    expect(classifyReferrer(null, { requestHost: 'site.example' })).toBeNull();
  });
});

describe('UTM, locale, session, CTA — normalisation bornée', () => {
  it('UTM : trim, minuscules, espaces collapses (CR/LF neutralisés), borne 128', () => {
    expect(normalizeUtmValue('  Newsletter  ')).toBe('newsletter');
    expect(normalizeUtmValue('Lancement   Produit')).toBe('lancement produit');
    // Les retours à la ligne sont des espaces comme les autres : aucun
    // caractère de contrôle n'atteint jamais la base.
    expect(normalizeUtmValue('camp\r\neinjection')).toBe('camp einjection');
    expect(normalizeUtmValue('a'.repeat(500))).toBe('a'.repeat(128));
    expect(normalizeUtmValue('')).toBeNull();
    expect(normalizeUtmValue(123)).toBeNull();
  });

  it('locale : forme BCP-47 simple, minuscule', () => {
    expect(normalizeAnalyticsLocale('fr-FR')).toBe('fr-fr');
    expect(normalizeAnalyticsLocale('fr')).toBe('fr');
    expect(normalizeAnalyticsLocale('invalide!')).toBeNull();
    expect(normalizeAnalyticsLocale('fr_FR')).toBeNull();
    expect(normalizeAnalyticsLocale('x'.repeat(40))).toBeNull();
  });

  it('session : UUID strict uniquement — tout le reste devient null (jamais stocké)', () => {
    const uuid = 'c9bf9e57-1685-4c89-bafb-ff5af830be8a';
    expect(normalizeAnalyticsSession(uuid)).toBe(uuid);
    expect(normalizeAnalyticsSession(uuid.toUpperCase())).toBe(uuid);
    // Injection hostile : session-idiots, scripts, trop longs, non UUID.
    expect(normalizeAnalyticsSession('page-1')).toBeNull();
    expect(normalizeAnalyticsSession('<script>alert(1)</script>')).toBeNull();
    expect(normalizeAnalyticsSession(`${uuid}-payload-supplémentaire`)).toBeNull();
    expect(normalizeAnalyticsSession('')).toBeNull();
    expect(normalizeAnalyticsSession(null)).toBeNull();
  });

  it('CTA id : borné, contrôle interdit', () => {
    expect(normalizeCtaId('hero-demo')).toBe('hero-demo');
    expect(normalizeCtaId('a'.repeat(200))).toBe('a'.repeat(64));
    expect(normalizeCtaId('id\r\ninjected')).toBeNull();
    expect(normalizeCtaId('')).toBeNull();
  });
});

describe('chemins exclus — admin/api/preview jamais comptés', () => {
  it('exclut les préfixes par défaut et leurs descendants', () => {
    expect(isExcludedAnalyticsPath('/admin')).toBe(true);
    expect(isExcludedAnalyticsPath('/admin/analytics')).toBe(true);
    expect(isExcludedAnalyticsPath('/admin/preview/abc')).toBe(true);
    expect(isExcludedAnalyticsPath('/api/analytics/event')).toBe(true);
    expect(isExcludedAnalyticsPath('/api/forms/contact')).toBe(true);
    // Insensible à la casse : `/Admin/…` ne devient jamais une page « populaire ».
    expect(isExcludedAnalyticsPath('/Admin')).toBe(true);
    expect(isExcludedAnalyticsPath('/ADMIN/preview/x')).toBe(true);
  });

  it('exclut par préfixe strict — pas d’effet de bord de type /apidoc', () => {
    expect(isExcludedAnalyticsPath('/apropos')).toBe(false);
    expect(isExcludedAnalyticsPath('/administratif')).toBe(false);
  });

  it('exclut les assets et accepte les préfixes supplémentaires du Project', () => {
    expect(isExcludedAnalyticsPath('/styles/global.css')).toBe(true);
    expect(isExcludedAnalyticsPath('/favicon.ico')).toBe(true);
    expect(isExcludedAnalyticsPath('/favicon.png')).toBe(true);
    expect(isExcludedAnalyticsPath('/interne/brouillons', ['/interne'])).toBe(true);
    expect(isExcludedAnalyticsPath('/interne', ['/interne'])).toBe(true);
    expect(isExcludedAnalyticsPath('/interneur', ['/interne'])).toBe(false);
  });
});

describe('bots, préfetch, signaux de vie privée', () => {
  it('détecte les crawlers évidents sans base d’UA géante', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBotUserAgent('curl/8.4.0')).toBe(true);
    expect(isBotUserAgent('HeadlessChrome/121')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (Macintosh) Chrome/121 Safari/537.36')).toBe(false);
    // UA absent : bruit toléré (politique assumée), pas un bot.
    expect(isBotUserAgent(null)).toBe(false);
    expect(isBotUserAgent('')).toBe(false);
  });

  it('classe l’appareil sans jamais stocker l’UA brut', () => {
    expect(deviceClassFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('mobile');
    expect(deviceClassFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('tablet');
    expect(deviceClassFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('desktop');
    expect(deviceClassFromUserAgent(null)).toBeNull();
  });

  it('détecte le préfetch/prerender', () => {
    const headers = (map: Record<string, string>): Headers =>
      new Headers(map) as Headers;
    expect(isPrefetchRequest(headers({ 'sec-purpose': 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(headers({ purpose: 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(headers({ 'x-moz': 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(headers({}))).toBe(false);
  });

  it('détecte DNT et GPC — politique conservative : signal ⇒ aucune collecte', () => {
    expect(hasExplicitPrivacySignal(new Headers({ dnt: '1' }))).toBe(true);
    expect(hasExplicitPrivacySignal(new Headers({ 'sec-gpc': '1' }))).toBe(true);
    expect(hasExplicitPrivacySignal(new Headers({ dnt: '0' }))).toBe(false);
    expect(hasExplicitPrivacySignal(new Headers({}))).toBe(false);
  });
});

describe('déduplication et agrégations (helpers purs)', () => {
  it('clé de déduplication : (session, événement, chemin, tranche 30 s)', () => {
    const t0 = new Date('2026-09-16T12:00:00.000Z');
    const t1 = new Date('2026-09-16T12:00:20.000Z');
    const t2 = new Date('2026-09-16T12:00:31.000Z'); // tranche suivante
    const session = 'c9bf9e57-1685-4c89-bafb-ff5af830be8a';
    const key = (now: Date) => analyticsDedupKey({ sessionId: session, eventName: 'page_view', path: '/', now });
    expect(key(t0)).toBe(key(t1)); // même tranche
    expect(key(t0)).not.toBe(key(t2)); // tranche suivante : rechargement légitime
    expect(key(t0)).toContain(session);
    // Sans session : pas de déduplication (clé nulle = insertion directe).
    expect(analyticsDedupKey({ sessionId: null, eventName: 'page_view', path: '/', now: t0 })).toBeNull();
    expect(ANALYTICS_DEDUP_WINDOW_MS).toBe(30_000);
  });

  it('résolution de contenu : /articles/foo → namespace + slug', () => {
    expect(splitContentPath('/articles/mon-slug')).toEqual({ namespace: 'articles', slug: 'mon-slug' });
    expect(splitContentPath('/articles/nested/slug')).toEqual({ namespace: 'articles', slug: 'nested/slug' });
    expect(splitContentPath('/')).toBeNull();
    expect(splitContentPath('/seul-segment')).toBeNull();
  });

  it('buckets journaliers UTC', () => {
    expect(utcDayKey(new Date('2026-09-16T23:59:59.999Z'))).toBe('2026-09-16');
    expect(utcDayKey(new Date('2026-09-17T00:00:00.000Z'))).toBe('2026-09-17');
  });
});

describe('parseClientEvent — whitelist stricte du payload beacon', () => {
  const session = 'c9bf9e57-1685-4c89-bafb-ff5af830be8a';

  it('page view valide : UTM, referrer, session, locale normalisés', () => {
    const result = parseClientEvent(
      {
        type: 'pv',
        path: '/articles/slug?x=1',
        ref: 'https://google.com/search?q=privé',
        session,
        utm: { source: 'Newsletter', medium: 'email', campaign: 'Launch 2026' },
        locale: 'fr-FR',
      },
      ctx,
    );
    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.event).toMatchObject({
      name: 'page_view',
      path: '/articles/slug',
      referrerDomain: 'google.com',
      referrerKind: 'external',
      sessionId: session,
      locale: 'fr-fr',
    });
    expect(result.event.utm).toEqual({
      source: 'newsletter',
      medium: 'email',
      campaign: 'launch 2026',
      content: null,
      term: null,
    });
  });

  it('navigation interne : referrer same-host classé internal', () => {
    const result = parseClientEvent(
      { type: 'pv', path: '/guides/a', ref: 'https://site.example/accueil', session },
      ctx,
    );
    expect(result.kind === 'valid' && result.event.referrerKind).toBe('internal');
  });

  it('cta valide avec identifiant borné', () => {
    const result = parseClientEvent({ type: 'cta', path: '/', session, id: 'hero' }, ctx);
    expect(result.kind === 'valid' && result.event.name).toBe('cta_click');
    expect(result.kind === 'valid' && result.event.ctaId).toBe('hero');
  });

  it('session invalide → null (événement compté, session ignorée)', () => {
    const result = parseClientEvent({ type: 'pv', path: '/', session: 'not-a-uuid' }, ctx);
    expect(result.kind === 'valid' && result.event.sessionId).toBeNull();
  });

  it('rejette les clés inconnues (whitelist stricte, pas de properties libres)', () => {
    expect(parseClientEvent({ type: 'pv', path: '/', extra: { nested: true } }, ctx).kind).toBe('invalid');
    expect(parseClientEvent({ type: 'ctam', path: '/' }, ctx).kind).toBe('invalid');
    expect(parseClientEvent({ type: 'form_accepted', path: '/', form: 'contact' }, ctx).kind).toBe('invalid');
    expect(parseClientEvent('chaîne', ctx).kind).toBe('invalid');
    expect(parseClientEvent(null, ctx).kind).toBe('invalid');
  });

  it('rejette les valeurs hors bornes de lecture (path géant, utm non chaîne)', () => {
    expect(parseClientEvent({ type: 'pv', path: `/${'a'.repeat(1000)}` }, ctx).kind).toBe('invalid');
    expect(parseClientEvent({ type: 'pv', path: '/', utm: { source: 42 } }, ctx).kind).toBe('invalid');
  });

  it('charge hostile typique : prototype-like keys rejetés, HTML stocké comme donnée', () => {
    // Clés prototype-like et structures arbitraires : rejetées (whitelist stricte).
    expect(parseClientEvent({ type: 'pv', path: '/', constructor: { prototype: {} } }, ctx).kind).toBe('invalid');
    expect(parseClientEvent({ type: 'cta', path: '/', id: 'a'.repeat(1000) }, ctx).kind).toBe('invalid');
    // Un path contenant du HTML est une donnée légitime (URL encodée) :
    // stocké verbatim via requête paramétrée, échappé au rendu — jamais exécuté.
    const result = parseClientEvent({ type: 'pv', path: '/tag/<script>alert(1)</script>' }, ctx);
    expect(result.kind === 'valid' && result.event.path).toBe('/tag/<script>alert(1)</script>');
  });
});

describe('borne de transport', () => {
  it('le corps JSON est borné à 2 KiB (anti-abus transport)', () => {
    expect(ANALYTICS_BODY_MAX_BYTES).toBe(2048);
  });
});
