import { describe, expect, it } from 'vitest';
import {
  formTokenAgeSeconds,
  issueFormToken,
  verifyFormToken,
} from '../src/domain/forms/token';
import { FORM_MIN_FILL_SECONDS, FORM_TOKEN_MAX_AGE_SECONDS } from '../src/domain/forms/policy';

/**
 * Jeton d'émission du formulaire — possession d'une vraie page, borné en
 * âge, insensible à la falsification de l'instant d'émission.
 */

const SECRET = 'secret-de-test-tres-long-0123456789abcdef';
const FORM_KEY = 'contact';

describe('issueFormToken / verifyFormToken', () => {
  it('un jeton signé émis puis vérifié immédiatement passe (âge < min-fill géré par le service)', () => {
    const now = new Date('2026-09-16T12:00:00Z');
    const { token } = issueFormToken({ formKey: FORM_KEY, secret: SECRET, issuedAt: now });
    const verification = verifyFormToken(token, {
      formKey: FORM_KEY,
      secret: SECRET,
      now: new Date(now.getTime() + FORM_MIN_FILL_SECONDS * 1000),
    });
    expect(verification).toEqual({
      ok: true,
      formKey: FORM_KEY,
      issuedAt: now,
    });
  });

  it('mauvais secret → bad-signature (temps constant, pas de crash)', () => {
    const { token } = issueFormToken({ formKey: FORM_KEY, secret: SECRET });
    const verification = verifyFormToken(token, {
      formKey: FORM_KEY,
      secret: 'autre-secret-completement-different-0123456789',
      now: new Date(),
    });
    expect(verification).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('falsification de l’instant d’émission → bad-signature', () => {
    const { token } = issueFormToken({ formKey: FORM_KEY, secret: SECRET });
    const parts = token.split('.');
    const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const forgedPayload = Buffer.from(
      payload.replace(/\d+$/, '1000000000'),
      'utf8',
    ).toString('base64url');
    const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`;
    expect(verifyFormToken(forged, { formKey: FORM_KEY, secret: SECRET, now: new Date() })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('jeton d’un autre formulaire → wrong-form', () => {
    const { token } = issueFormToken({ formKey: 'devis', secret: SECRET });
    expect(verifyFormToken(token, { formKey: FORM_KEY, secret: SECRET, now: new Date() })).toEqual({
      ok: false,
      reason: 'wrong-form',
    });
  });

  it('jeton expiré au-delà de l’âge maximal → expired', () => {
    const longAgo = new Date(Date.now() - (FORM_TOKEN_MAX_AGE_SECONDS + 60) * 1000);
    const { token } = issueFormToken({ formKey: FORM_KEY, secret: SECRET, issuedAt: longAgo });
    expect(verifyFormToken(token, { formKey: FORM_KEY, secret: SECRET, now: new Date() })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('jetons mal formés → malformed', () => {
    for (const hostile of ['', 'abc', 'v1.abc', 'a.b.c.d', 'v9.abc.def']) {
      expect(verifyFormToken(hostile, { formKey: FORM_KEY, secret: SECRET, now: new Date() }).ok).toBe(
        false,
      );
    }
  });

  it('jeton non signé (build sans secret) → rejeté explicitement', () => {
    const issued = issueFormToken({ formKey: FORM_KEY, secret: null });
    expect(issued.signed).toBe(false);
    expect(verifyFormToken(issued.token, { formKey: FORM_KEY, secret: SECRET, now: new Date() })).toEqual(
      { ok: false, reason: 'unsigned' },
    );
  });

  it('re-signe un jeton valide en conservant l’instant d’émission (re-rendu d’erreurs)', () => {
    const issuedAt = new Date(Date.now() - 60 * 1000);
    const { token } = issueFormToken({ formKey: FORM_KEY, secret: SECRET, issuedAt });
    const verification = verifyFormToken(token, { formKey: FORM_KEY, secret: SECRET, now: new Date() });
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    const reissued = issueFormToken({
      formKey: FORM_KEY,
      secret: SECRET,
      reissueIssuedAt: verification.issuedAt,
    });
    const age = formTokenAgeSeconds(reissued.issuedAt, new Date());
    expect(age).toBeGreaterThanOrEqual(60);
    expect(
      verifyFormToken(reissued.token, { formKey: FORM_KEY, secret: SECRET, now: new Date() }).ok,
    ).toBe(true);
  });

  it('deux secrets différents produisent des jetons distincts (pas de secret par défaut)', () => {
    const a = issueFormToken({ formKey: FORM_KEY, secret: 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa' });
    const b = issueFormToken({ formKey: FORM_KEY, secret: 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb' });
    expect(a.token).not.toBe(b.token);
  });
});
