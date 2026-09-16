import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import type { ContactRequestsRepository } from '../data/repositories/contact-requests.js';
import type { RateLimitsRepository } from '../data/repositories/rate-limits.js';
import type { KreizContactRequest } from '../data/tables/contact-requests.js';
import type { ContactFormDeclaration } from '../domain/forms/declaration.js';
import { contactReplyToFieldName } from '../domain/forms/declaration.js';
import {
  type ContactFieldErrors,
  type ContactFieldValue,
  validateContactPayload,
} from '../domain/forms/fields.js';
import { ContactSubmissionError, contactRateLimitedUserMessage } from '../domain/forms/errors.js';
import {
  CONTACT_DEDUP_WINDOW_MS,
  CONTACT_NOTIFICATION_MAX_ATTEMPTS,
  CONTACT_RATE_LIMIT_MAX,
  CONTACT_RATE_LIMIT_WINDOW_MS,
  FORM_MIN_FILL_SECONDS,
  contactNotificationBackoffMs,
  contactRateLimitKey,
  isSafeEmailAddress,
} from '../domain/forms/policy.js';
import { formTokenAgeSeconds, verifyFormToken } from '../domain/forms/token.js';
import { pseudonymizeIp } from './auth-tokens.js';
import { CONTACT_AUDIT_ACTIONS, auditContactNotificationFailed } from './contact-audit.js';
import type { MailAddress, Mailer } from '../ports/mailer.js';

/**
 * Service de contact (cadrage §13) — orchestration d'une soumission :
 *
 *     honeypot → rate limit → jeton → temps min. → validation stricte
 *       → idempotence (insert … on conflict) → **persisté d'abord**
 *       → notification (best effort, at-least-once) → audit
 *
 * Deux invariants structurels :
 * 1. **La demande est persistée avant toute tentative d'envoi** — une panne
 *    email (ou son absence de configuration) ne perd jamais une soumission ;
 * 2. **l'enveloppe email ne contient jamais d'entrée visiteur comme
 *    destinataire** — `to` = déclaration en code, `from` = env serveur,
 *    `reply-to` = unique champ email validé. Kreiz ne peut pas être utilisé
 *    comme relais d'envoi.
 *
 * Vie privée : l'IP n'est jamais persistée — elle est HMACée (`KREIZ_SECRET`)
 * pour la clé de rate limiting et la clé d'idempotence (finalité anti-abus
 * exclusivement, même dérivation que le login), puis jetée.
 */

export interface ContactServiceDeps {
  requests: ContactRequestsRepository;
  rateLimits: RateLimitsRepository;
  audit: AdminAuditLogRepository;
  /** Transport email — `null` : demandes stockées, notification `not_configured`. */
  mailer: Mailer | null;
  /** Expéditeur d'enveloppe — requis dès qu'un `mailer` est configuré. */
  mailFrom: MailAddress | null;
  /** Secret de déploiement (HMAC d'idempotence et de pseudonymisation d'IP). */
  secret: string;
  /**
   * Récepteur analytics (slice 8) — conversions serveur uniquement
   * (`form_accepted` à l'acceptation, `form_notification_sent` à la
   * livraison). Aucune donnée visiteur n'y entre ; `null` : aucune mesure.
   */
  analytics?: ContactAnalyticsSink | null;
  /**
   * Résolveur des formulaires déclarés (registre runtime) — utilisé par le
   * balayage de rattrapage pour reconstruire l'enveloppe des demandes plus
   * anciennes que le processus. `null` hors runtime Vite (tests injectent
   * le formulaire directement).
   */
  forms?: { findById(formId: string): ContactFormDeclaration | null } | null;
}

/**
 * Récepteur des conversions analytics — interface étroite (jamais le
 * service entier) pour garder la dépendance contact → analytics en un seul
 * point, sans cycle.
 */
export interface ContactAnalyticsSink {
  recordConversion(input: {
    name: 'form_accepted' | 'form_notification_sent';
    formKey: string;
    page: string | null;
    now?: Date;
  }): Promise<boolean>;
}

export type ContactSubmissionOutcome =
  | { kind: 'submitted'; request: KreizContactRequest; notification: ContactNotificationOutcome | null }
  /** Double soumission idempotente — même ligne retournée, pas d'erreur visible. */
  | { kind: 'duplicate'; request: KreizContactRequest }
  /** Signal de bot (honeypot ou remplissage instantané) — l'HTTP répondra comme un succès. */
  | { kind: 'spam-signal' }
  | { kind: 'invalid-token' }
  | { kind: 'invalid-payload'; fieldErrors: ContactFieldErrors }
  | { kind: 'rate-limited'; retryAfterSeconds: number };

export type ContactNotificationOutcome =
  | { status: 'sent' }
  | { status: 'failed'; failure: NonNullable<KreizContactRequest['notificationFailure']> }
  | { status: 'exhausted'; failure: NonNullable<KreizContactRequest['notificationFailure']> };

export function createContactService(deps: ContactServiceDeps) {
  const { requests, rateLimits, audit, mailer, mailFrom, secret, analytics } = deps;

  function ipHash(clientIp: string | null | undefined): string {
    return pseudonymizeIp(clientIp ?? 'unknown', secret);
  }

  /**
   * Clé d'idempotence — calculée **serveur** : HMAC du formulaire, du
   * payload **validé** (jamais du POST brut), du client pseudonymisé et
   * d'une tranche temporelle. Un double POST (double-clic, refresh, réseau
   * instable) retombe sur la même clé dans la fenêtre ; deux visiteurs
   * distincts (ou un renvoi légitime plus tard) ne la partagent pas.
   */
  function computeDedupKey(options: {
    formKey: string;
    payload: Record<string, ContactFieldValue>;
    clientKey: string;
    now: Date;
  }): string {
    const bucket = Math.floor(options.now.getTime() / CONTACT_DEDUP_WINDOW_MS);
    const canonical = JSON.stringify(canonicalize(options.payload));
    return pseudonymizeIp(`${options.formKey}|${canonical}|${bucket}`, `${secret}:${options.clientKey}`);
  }

  /** Traite une soumission publique brute (valeurs whitelistées par le parseur HTTP). */
  async function submit(input: {
    form: ContactFormDeclaration;
    /** Valeurs brutes des champs déclarés uniquement (parseur HTTP whitelist). */
    values: Record<string, string | boolean>;
    /** Honeypot rempli — signal de bot immédiat. */
    honeypotFilled: boolean;
    /** Jeton d'émission soumis. */
    token: string;
    clientIp: string | null;
    /** Chemin referer same-origin normalisé — conversion analytics uniquement. */
    analyticsPage?: string | null;
    now?: Date;
  }): Promise<ContactSubmissionOutcome> {
    const now = input.now ?? new Date();
    const clientKey = ipHash(input.clientIp);

    // 1. Honeypot — rejet silencieux (l'HTTP répondra comme un succès : ne
    // jamais apprendre au bot qu'il a été détecté).
    if (input.honeypotFilled) {
      return { kind: 'spam-signal' };
    }

    // 2. Rate limiting — compté AVANT toute validation (coût des requêtes
    // hostiles inclus). Clé = formulaire × hash d'IP.
    const counter = await rateLimits.incrementWindowed(
      contactRateLimitKey(input.form.key, clientKey),
      { windowMs: CONTACT_RATE_LIMIT_WINDOW_MS, now },
    );
    if (counter.count > CONTACT_RATE_LIMIT_MAX) {
      const windowEndsAt = counter.windowStartedAt.getTime() + CONTACT_RATE_LIMIT_WINDOW_MS;
      const retryAfterSeconds = Math.max(1, Math.ceil((windowEndsAt - now.getTime()) / 1000));
      return { kind: 'rate-limited', retryAfterSeconds };
    }

    // 3. Jeton d'émission — possession d'une vraie page, âge maximal.
    const verification = verifyFormToken(input.token, { formKey: input.form.key, secret, now });
    if (!verification.ok) {
      return { kind: 'invalid-token' };
    }

    // 4. Temps minimal de remplissage — mesuré depuis l'**émission du
    // jeton** (serveur) ; un remplissage instantané est un signal de bot,
    // traité exactement comme le honeypot (silence).
    const ageSeconds = formTokenAgeSeconds(verification.issuedAt, now);
    if (ageSeconds < FORM_MIN_FILL_SECONDS) {
      return { kind: 'spam-signal' };
    }

    // 5. Validation stricte du payload (schéma dérivé, whitelist, bornes).
    const validated = validateContactPayload(input.form.fields, input.values);
    if (!validated.ok) {
      return { kind: 'invalid-payload', fieldErrors: validated.fieldErrors };
    }
    const payload = validated.payload;

    // 6. Persistance idempotente — AVANT toute notification. Un formulaire
    // sans bloc `notification` ne sera jamais notifié (choix du Project).
    const notificationConfigured =
      mailer !== null && mailFrom !== null && input.form.notification !== undefined;
    const dedupKey = computeDedupKey({ formKey: input.form.key, payload, clientKey, now });
    const inserted = await requests.insertOrFindDuplicate({
      formId: input.form.key,
      payload,
      notificationStatus: notificationConfigured ? 'pending' : 'not_configured',
      notificationNextAttemptAt: notificationConfigured ? now : null,
      dedupKey,
      createdAt: now,
    });
    if (inserted.duplicate) {
      return { kind: 'duplicate', request: inserted.request };
    }

    await audit.append({
      actorAdminId: null,
      action: CONTACT_AUDIT_ACTIONS.submitted,
      entityType: 'contact_request',
      entityId: inserted.request.id,
      metadata: {
        form: input.form.key,
        notification: notificationConfigured ? 'pending' : 'not_configured',
      },
    });

    // Conversion analytics (slice 8) — soumission **réellement acceptée**
    // uniquement. Jamais le payload, jamais l'email : clé de formulaire,
    // page referer (déjà normalisée) et horodatage seulement. Un échec de
    // mesure est avalé par le récepteur : la mesure ne casse jamais le
    // produit qu'elle observe.
    await analytics?.recordConversion({
      name: 'form_accepted',
      formKey: input.form.key,
      page: input.analyticsPage ?? null,
      now,
    });

    // 7. Notification — best effort, la demande existe déjà.
    const notification = notificationConfigured
      ? await attemptNotification({
          request: inserted.request,
          form: input.form,
          source: 'submission',
          actorAdminId: null,
          now,
        })
      : null;

    return { kind: 'submitted', request: inserted.request, notification };
  }

  /**
   * Tente l'envoi d'une notification pour une demande — claim conditionnel
   * puis transport unique. L'échec est persisté (`failed` + kind/statut +
   * prochaine échéance) : jamais une perte, jamais une donnée visiteur dans
   * la trace.
   */
  async function attemptNotification(options: {
    request: KreizContactRequest;
    form: ContactFormDeclaration;
    source: 'submission' | 'admin' | 'recovery';
    actorAdminId: string | null;
    now?: Date;
  }): Promise<ContactNotificationOutcome | null> {
    if (!mailer || !mailFrom) return null;
    const now = options.now ?? new Date();

    // Claim : un seul chemin (soumission, balayage, admin) envoie réellement.
    const claimed = await requests.claimNotificationAttempt(options.request.id, {
      expectedAttempts: options.request.notificationAttempts,
    });
    if (!claimed) return null;

    const result = await mailer.send(buildNotificationEmail(options.form, claimed));
    if (result.ok) {
      await requests.markNotified(claimed.id, { notifiedAt: now });
      // Livraison de la notification = événement analytics optionnel
      // (signal produit ; la traçabilité opérationnelle reste dans l'audit).
      await analytics?.recordConversion({
        name: 'form_notification_sent',
        formKey: options.form.key,
        page: null,
        now,
      });
      return { status: 'sent' };
    }

    const attempts = claimed.notificationAttempts;
    const exhausted = attempts >= CONTACT_NOTIFICATION_MAX_ATTEMPTS;
    const nextAttemptAt = exhausted ? null : new Date(now.getTime() + contactNotificationBackoffMs(attempts));
    await requests.markNotificationFailed(claimed.id, { failure: result.failure, nextAttemptAt });
    await auditContactNotificationFailed(audit, {
      requestId: claimed.id,
      formKey: options.form.key,
      attempt: attempts,
      failureKind: result.failure.kind,
      source: options.source,
      actorAdminId: options.actorAdminId,
    });
    return exhausted
      ? { status: 'exhausted', failure: result.failure }
      : { status: 'failed', failure: result.failure };
  }

  /** Enveloppe email — destinataires/sujet déclarés, reply-to validé, jamais l'inverse. */
  function buildNotificationEmail(form: ContactFormDeclaration, request: KreizContactRequest) {
    const notification = form.notification;
    if (!notification) {
      throw new Error('@kreiz/core : notification email demandée sans configuration de formulaire.');
    }
    const replyToField = contactReplyToFieldName(form);
    const replyToValue = replyToField ? request.payload[replyToField] : undefined;
    const replyTo =
      typeof replyToValue === 'string' && isSafeEmailAddress(replyToValue) ? { email: replyToValue } : null;
    return {
      from: { email: mailFrom!.email, ...(mailFrom!.name ? { name: mailFrom!.name } : {}) },
      to: notification.recipients.map((address) => ({ email: address })),
      replyTo,
      subject: notification.subject,
      text: renderNotificationText(form, request),
    };
  }

  return {
    /** Message utilisateur du rate limiting (formulaire re-rendu 429). */
    rateLimitedMessage(retryAfterSeconds: number): string {
      return contactRateLimitedUserMessage(retryAfterSeconds);
    },

    submit,

    /** Boîte admin : liste bornée, plus récentes d'abord. */
    listRequests: requests.list,
    getRequest: requests.findById,
    countNew: requests.countNew,

    /** Transition `new` ⇄ `handled` — auditée au nom de l'admin. */
    async markStatus(options: {
      requestId: string;
      status: KreizContactRequest['status'];
      actorAdminId: string;
    }): Promise<KreizContactRequest | null> {
      const updated = await requests.updateStatus(options.requestId, options.status);
      if (updated) {
        await audit.append({
          actorAdminId: options.actorAdminId,
          action: CONTACT_AUDIT_ACTIONS.statusChanged,
          entityType: 'contact_request',
          entityId: updated.id,
          metadata: { form: updated.formId, to: options.status },
        });
      }
      return updated;
    },

    /**
     * Relance manuelle de la notification (échec terminal, transport ajouté
     * après coup, incident résolu) — compteur remis à zéro, envoi immédiat.
     */
    async retryNotification(options: {
      requestId: string;
      form: ContactFormDeclaration;
      actorAdminId: string;
      now?: Date;
    }): Promise<ContactNotificationOutcome | null> {
      if (!mailer || !mailFrom) return null;
      const request = await requests.findById(options.requestId);
      if (!request || request.notificationStatus === 'sent') return null;
      const rearmed = await requests.rearmNotification(options.requestId, { now: options.now ?? new Date() });
      if (!rearmed) return null;
      await audit.append({
        actorAdminId: options.actorAdminId,
        action: CONTACT_AUDIT_ACTIONS.notificationRetried,
        entityType: 'contact_request',
        entityId: rearmed.id,
        metadata: { form: rearmed.formId },
      });
      return attemptNotification({
        request: { ...rearmed, notificationAttempts: 0 },
        form: options.form,
        source: 'admin',
        actorAdminId: options.actorAdminId,
        now: options.now,
      });
    },

    /**
     * Balayage de rattrapage (cron futur, même statut que la récupération
     * médias) : promotion des `not_configured` quand un transport devient
     * disponible, puis envoi des notifications dues. Acteur d'audit :
     * `NULL` + `metadata.source: 'recovery'` — action système.
     */
    async runNotificationRecovery(
      options: { limit?: number; now?: Date } = {},
    ): Promise<{ promoted: number; sent: number; failed: number; skipped: number }> {
      const now = options.now ?? new Date();
      if (!mailer || !mailFrom) {
        return { promoted: 0, sent: 0, failed: 0, skipped: 0 };
      }
      const promoted = await requests.promoteNotConfigured({ limit: options.limit ?? 50, now });
      const due = await requests.listNotificationDue({
        now,
        limit: options.limit ?? 25,
        maxAttempts: CONTACT_NOTIFICATION_MAX_ATTEMPTS,
      });
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      for (const request of due) {
        const form = deps.forms?.findById(request.formId) ?? null;
        if (!form || !form.notification) {
          // Formulaire retiré du code (ou son bloc notification) : pas
          // d'enveloppe possible — la demande reste visible et relançable,
          // jamais écrasée silencieusement.
          skipped += 1;
          continue;
        }
        const outcome = await attemptNotification({ request, form, source: 'recovery', actorAdminId: null, now });
        if (outcome?.status === 'sent') sent += 1;
        else if (outcome) failed += 1;
        else skipped += 1;
      }
      return { promoted, sent, failed, skipped };
    },
  };
}

/** Corps texte de la notification — texte brut, borné par le schéma des champs. */
function renderNotificationText(form: ContactFormDeclaration, request: KreizContactRequest): string {
  const lines: string[] = [];
  lines.push(`Nouveau message reçu via le formulaire « ${form.label} ».`);
  lines.push('');
  for (const [name, descriptor] of Object.entries(form.fields)) {
    const value = request.payload[name];
    if (value === undefined) continue;
    const display =
      typeof value === 'boolean' ? 'oui' : descriptor.kind === 'textarea' ? `\n${value}\n` : value;
    lines.push(`${descriptor.label} : ${display}`);
  }
  lines.push('');
  lines.push(`— Reçu le ${request.createdAt.toISOString()} (formulaire « ${form.key} »)`);
  return lines.join('\n');
}

/** Ordre stable des clés du payload — la clé d'idempotence ne dépend pas de l'ordre du POST. */
function canonicalize(payload: Record<string, ContactFieldValue>): Record<string, ContactFieldValue> {
  const sorted: Record<string, ContactFieldValue> = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key]!;
  }
  return sorted;
}

export type ContactService = ReturnType<typeof createContactService>;

/** Erreur exposée pour les tests et les routes — re-export local du domaine. */
export { ContactSubmissionError };
