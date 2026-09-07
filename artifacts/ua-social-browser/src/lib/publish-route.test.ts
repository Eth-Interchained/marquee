import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  apiSurface,
  platformsWithApiMode,
  routeFor,
  type PublishConfig,
  type PostShape,
} from './publish-route.ts';

/** Everything configured. Individual tests take one thing away. */
const READY: PublishConfig = {
  metaConnected: true,
  threadsConnected: true,
  pageSelected: true,
  professionalAccount: true,
  mediaHostConfigured: true,
};

const SIGNED_IN = { signedIn: true };

const textPost = (platform: PostShape['platform']): PostShape => ({
  platform,
  hasMedia: false,
  mediaHosted: false,
});

describe('only three networks have an API mode, and they are the Meta three', () => {
  test('threads, facebook and instagram', () => {
    assert.deepEqual(platformsWithApiMode().sort(), [
      'facebook',
      'instagram',
      'threads',
    ]);
  });

  test('a network with no publishing API says so rather than looking broken', () => {
    const decision = routeFor(textPost('bluesky'), READY, SIGNED_IN, 'api');
    const api = decision.modes.find((mode) => mode.mode === 'api');

    assert.equal(api?.available, false);
    assert.match(api?.blockers[0] ?? '', /no sanctioned publishing API/);
    assert.equal(decision.chosen, 'session', 'and it still publishes');
  });

  test('Threads is text-native, which is why it is the best fit here', () => {
    assert.equal(apiSurface('threads')?.textOnly, true);
  });

  test('Instagram is not, which is the most consequential fact in the table', () => {
    assert.equal(apiSurface('instagram')?.textOnly, false);
  });
});

describe('a platform limit is not a transport problem', () => {
  test('a text-only Instagram post is blocked in BOTH modes', () => {
    // The mistake this prevents: reporting "the API mode is unavailable" would
    // send the operator switching modes to fix something no mode fixes.
    const decision = routeFor(textPost('instagram'), READY, SIGNED_IN, 'api');

    assert.equal(decision.chosen, null);
    for (const mode of decision.modes) {
      assert.equal(mode.available, false, `${mode.mode} should be blocked`);
      assert.match(mode.blockers[0], /no text-only post/);
    }
  });

  test('the summary leads with the reason no mode can fix', () => {
    const decision = routeFor(textPost('instagram'), READY, SIGNED_IN, 'api');
    assert.match(decision.summary, /limit of the network, not of either/);
  });

  test('the same post with media attached is fine', () => {
    const decision = routeFor(
      { platform: 'instagram', hasMedia: true, mediaHosted: true },
      READY,
      SIGNED_IN,
      'api',
    );
    assert.equal(decision.chosen, 'api');
  });
});

describe('the API mode states its own preconditions', () => {
  test('an unconnected account is named, not silently skipped', () => {
    const decision = routeFor(
      textPost('facebook'),
      { ...READY, metaConnected: false },
      SIGNED_IN,
      'api',
    );
    assert.match(decision.modes[0].blockers[0], /Connect Meta in Settings/);
  });

  test('Threads signing in separately is explained, not conflated with Meta', () => {
    // Same developer account, different token. An operator who has connected
    // Facebook and sees Threads refused deserves to know why.
    const decision = routeFor(
      textPost('threads'),
      { ...READY, threadsConnected: false },
      SIGNED_IN,
      'api',
    );
    assert.match(decision.modes[0].blockers[0], /Threads signs in separately/);
  });

  test('Facebook without a Page points at the session mode as the answer', () => {
    // This one is not fixable by configuring anything: the API cannot post to
    // a personal profile at all, so the useful advice is the other mode.
    const decision = routeFor(
      textPost('facebook'),
      { ...READY, pageSelected: false },
      SIGNED_IN,
      'api',
    );

    assert.match(decision.modes[0].blockers[0], /never as a personal profile/);
    assert.equal(decision.chosen, 'session');
  });

  test('a personal Instagram account cannot use the API mode', () => {
    const decision = routeFor(
      { platform: 'instagram', hasMedia: true, mediaHosted: true },
      { ...READY, professionalAccount: false },
      SIGNED_IN,
      'api',
    );
    assert.match(decision.modes[0].blockers[0], /Business or Creator/);
  });

  test('a Page requirement is not applied to Instagram', () => {
    const decision = routeFor(
      { platform: 'instagram', hasMedia: true, mediaHosted: true },
      { ...READY, pageSelected: false },
      SIGNED_IN,
      'api',
    );
    assert.equal(decision.chosen, 'api', 'Instagram does not publish as a Page');
  });
});

describe('media has to be somewhere the network can fetch it', () => {
  test('unhosted media blocks the API mode, because the network pulls a URL', () => {
    const decision = routeFor(
      { platform: 'instagram', hasMedia: true, mediaHosted: false },
      READY,
      SIGNED_IN,
      'api',
    );
    assert.match(decision.modes[0].blockers[0], /needs uploading to the host/);
  });

  test('with no host configured at all, the message is the missing host', () => {
    const decision = routeFor(
      { platform: 'instagram', hasMedia: true, mediaHosted: false },
      { ...READY, mediaHostConfigured: false },
      SIGNED_IN,
      'api',
    );
    assert.match(decision.modes[0].blockers[0], /No media host is configured/);
  });

  test('a text post is never nagged about media hosting', () => {
    // Noise on a Threads text post would train the operator to ignore these.
    const decision = routeFor(
      textPost('threads'),
      { ...READY, mediaHostConfigured: false },
      SIGNED_IN,
      'api',
    );
    assert.equal(decision.chosen, 'api');
    assert.deepEqual(decision.modes[0].blockers, []);
  });
});

describe('the session mode keeps its own condition', () => {
  test('a workspace that is not signed in cannot use it', () => {
    const decision = routeFor(
      textPost('x'),
      READY,
      { signedIn: false },
      'session',
    );
    const session = decision.modes.find((mode) => mode.mode === 'session');

    assert.equal(session?.available, false);
    assert.match(session?.blockers[0] ?? '', /not signed in/);
  });

  test('with no session and no API surface, nothing is available', () => {
    const decision = routeFor(
      textPost('reddit'),
      READY,
      { signedIn: false },
      'session',
    );
    assert.equal(decision.chosen, null);
  });
});

describe('the operator’s preference is honoured, and a substitution is announced', () => {
  test('the preferred mode wins when it is open', () => {
    const threads = textPost('threads');
    assert.equal(routeFor(threads, READY, SIGNED_IN, 'api').chosen, 'api');
    assert.equal(
      routeFor(threads, READY, SIGNED_IN, 'session').chosen,
      'session',
    );
  });

  test('falling back to the other mode says so out loud', () => {
    // Substituting the transport under a post without a word is exactly the
    // kind of quiet decision this app does not make.
    const decision = routeFor(
      textPost('facebook'),
      { ...READY, metaConnected: false },
      SIGNED_IN,
      'api',
    );

    assert.equal(decision.chosen, 'session');
    assert.match(decision.summary, /will go through your signed-in session instead/);
  });

  test('the reverse substitution is announced too', () => {
    const decision = routeFor(
      textPost('threads'),
      READY,
      { signedIn: false },
      'session',
    );

    assert.equal(decision.chosen, 'api');
    assert.match(decision.summary, /publish directly through the network/);
  });

  test('a summary is always populated, whatever happened', () => {
    const cases: Array<[PostShape, PublishConfig, boolean]> = [
      [textPost('x'), READY, true],
      [textPost('instagram'), READY, true],
      [textPost('threads'), { ...READY, threadsConnected: false }, false],
    ];
    for (const [post, config, signedIn] of cases) {
      const decision = routeFor(post, config, { signedIn }, 'api');
      assert.ok(decision.summary.length > 0);
    }
  });
});
