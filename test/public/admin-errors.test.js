import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../../public/js/admin-errors.js';

const GENERIC = 'Etwas ist schiefgelaufen. Bitte erneut versuchen.';

test('errorMessage maps every admin/auth API code to the spec copy', () => {
  const expected = {
    invalid_credentials: 'Benutzername oder Passwort falsch.',
    username_taken: 'Dieser Benutzername ist bereits vergeben.',
    invalid_username:
      'Benutzername: 1–32 Zeichen, nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich.',
    invalid_password: 'Das Passwort muss 8–256 Zeichen lang sein.',
    cannot_delete_self: 'Du kannst dein eigenes Konto nicht löschen.',
    cannot_change_own_role: 'Du kannst deine eigene Rolle nicht ändern.',
    last_admin: 'Es muss mindestens ein Admin bestehen bleiben.',
    not_found: 'Dieses Konto gibt es nicht mehr.',
  };
  for (const [code, text] of Object.entries(expected)) {
    assert.equal(errorMessage(code), text, code);
  }
});

test('errorMessage falls back to the generic line for unknown, network and unmapped codes', () => {
  for (const code of ['unknown', 'network', 'invalid_role', 'forbidden', '']) {
    assert.equal(errorMessage(code), GENERIC, code);
  }
});

test('too_many_attempts without Retry-After says "später"', () => {
  assert.equal(
    errorMessage('too_many_attempts'),
    'Zu viele Fehlversuche. Bitte später erneut versuchen.',
  );
  assert.equal(
    errorMessage('too_many_attempts', null),
    'Zu viele Fehlversuche. Bitte später erneut versuchen.',
  );
});

test('too_many_attempts rounds Retry-After up to whole minutes, at least 1, singular for 1', () => {
  const cases = [
    [0, 'Bitte in 1 Minute erneut versuchen.'],
    [1, 'Bitte in 1 Minute erneut versuchen.'],
    [60, 'Bitte in 1 Minute erneut versuchen.'],
    [61, 'Bitte in 2 Minuten erneut versuchen.'],
    [900, 'Bitte in 15 Minuten erneut versuchen.'],
  ];
  for (const [seconds, tail] of cases) {
    assert.equal(
      errorMessage('too_many_attempts', /** @type {number} */ (seconds)),
      `Zu viele Fehlversuche. ${tail}`,
      String(seconds),
    );
  }
});
