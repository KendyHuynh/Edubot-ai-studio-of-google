import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFirebaseAuthSettingsUrl,
  getAuthorizedFallbackPortalUrl,
  isHostnameAuthorized,
} from './authDomains';

const SAMPLE_AUTHORIZED = [
  'gen-lang-client-0194033910.firebaseapp.com',
  'gen-lang-client-0194033910.web.app',
  'ais-dev-74lhqf4gdw7r3g5pnltlxr-197088726295.asia-southeast1.run.app',
  'ais-pre-74lhqf4gdw7r3g5pnltlxr-197088726295.asia-southeast1.run.app',
];

test('isHostnameAuthorized matches exact domains and valid subdomains while rejecting spoofing', () => {
  assert.equal(
    isHostnameAuthorized(
      'ais-dev-74lhqf4gdw7r3g5pnltlxr-197088726295.asia-southeast1.run.app',
      SAMPLE_AUTHORIZED,
    ),
    true,
  );
  assert.equal(
    isHostnameAuthorized(
      'AIS-PRE-74LHQF4GDW7R3G5PNLTLXR-197088726295.asia-southeast1.run.app.',
      SAMPLE_AUTHORIZED,
    ),
    true,
  );
  assert.equal(
    isHostnameAuthorized('sub.gen-lang-client-0194033910.web.app', SAMPLE_AUTHORIZED),
    true,
  );
  assert.equal(isHostnameAuthorized('localhost', SAMPLE_AUTHORIZED), false);
  assert.equal(isHostnameAuthorized('teacher.github.io', SAMPLE_AUTHORIZED), false);
  assert.equal(
    isHostnameAuthorized('evil-gen-lang-client-0194033910.firebaseapp.com', SAMPLE_AUTHORIZED),
    false,
  );
});

test('getAuthorizedFallbackPortalUrl resolves pre-authorized applet URL only when current host is unauthorized', () => {
  // Already authorized -> null
  assert.equal(
    getAuthorizedFallbackPortalUrl(
      'https://ais-pre-74lhqf4gdw7r3g5pnltlxr-197088726295.asia-southeast1.run.app',
      SAMPLE_AUTHORIZED,
    ),
    null,
  );

  // On localhost -> prefers devAppUrl
  assert.equal(
    getAuthorizedFallbackPortalUrl(
      'http://localhost:3000',
      SAMPLE_AUTHORIZED,
      {
        devAppUrl: 'https://ais-dev-74lhqf4gdw7r3g5pnltlxr-197088726295.asia-southeast1.run.app',
        sharedAppUrl: 'https://ais-pre-74lhqf4gdw7r3g5pnltlxr-197088726295.asia-southeast1.run.app',
      },
      '/teacher',
    ),
    'https://ais-dev-74lhqf4gdw7r3g5pnltlxr-197088726295.asia-southeast1.run.app/teacher',
  );

  // On unconfigured GitHub Pages -> prefers ais-pre-* Shared App URL
  assert.equal(
    getAuthorizedFallbackPortalUrl(
      'https://teacher.github.io',
      SAMPLE_AUTHORIZED,
      undefined,
      '/teacher',
    ),
    'https://ais-pre-74lhqf4gdw7r3g5pnltlxr-197088726295.asia-southeast1.run.app/teacher',
  );
});

test('buildFirebaseAuthSettingsUrl generates exact Firebase Console settings link', () => {
  assert.equal(
    buildFirebaseAuthSettingsUrl('gen-lang-client-0194033910'),
    'https://console.firebase.google.com/project/gen-lang-client-0194033910/authentication/settings',
  );
});
