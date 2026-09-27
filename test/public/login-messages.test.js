import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginErrorMessage, throttleMessage } from '../../public/js/login-messages.js';

test('invalid_credentials maps to the wrong-credentials text', () => {
  assert.equal(loginErrorMessage('invalid_credentials', null), 'Benutzername oder Passwort falsch.');
});

test('too_many_attempts rounds Retry-After up to whole minutes', () => {
  assert.equal(
    loginErrorMessage('too_many_attempts', 840),
    'Zu viele Fehlversuche. Bitte in 14 Minuten erneut versuchen.',
  );
  assert.equal(throttleMessage(841), 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');
  assert.equal(throttleMessage(61), 'Zu viele Fehlversuche. Bitte in 2 Minuten erneut versuchen.');
});

test('too_many_attempts uses the singular with a floor of 1 minute', () => {
  assert.equal(throttleMessage(60), 'Zu viele Fehlversuche. Bitte in 1 Minute erneut versuchen.');
  assert.equal(throttleMessage(1), 'Zu viele Fehlversuche. Bitte in 1 Minute erneut versuchen.');
  assert.equal(throttleMessage(0), 'Zu viele Fehlversuche. Bitte in 1 Minute erneut versuchen.');
});

test('too_many_attempts without Retry-After falls back to "später"', () => {
  assert.equal(
    loginErrorMessage('too_many_attempts', null),
    'Zu viele Fehlversuche. Bitte später erneut versuchen.',
  );
});

test('every other code and a non-ApiError failure fall back to the generic text', () => {
  const generic = 'Etwas ist schiefgelaufen. Bitte erneut versuchen.';
  assert.equal(loginErrorMessage('internal', null), generic);
  assert.equal(loginErrorMessage('invalid_json', null), generic);
  assert.equal(loginErrorMessage(null, null), generic);
});
