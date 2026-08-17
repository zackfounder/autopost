/**
 * A fake Bluesky, built from the `data-testid` attributes the real client ships.
 *
 * Those testids are the most trustworthy selectors in this whole project: the
 * Bluesky client is open source and its own end-to-end tests depend on them, so
 * they are load-bearing for the Bluesky team too. Same caveat as the LinkedIn
 * fixtures though — this is a reconstruction, and passing here is not the same
 * as passing against the live site.
 */
const CHROME = `
<style>
  body { font-family: system-ui; margin: 0; padding: 20px; }
  .hidden { display: none; }
  [contenteditable] { border: 1px solid #999; min-height: 50px; padding: 8px; }
</style>
<nav><div data-testid="homeScreenFeedTabs">Following</div></nav>
`;

/**
 * Home, with the composer behind the floating action button.
 *
 * `deleted` drops the first post. deletePost() reloads the listing and refuses
 * to report success while the text is still on the page — so without this the
 * fixture would fail a correct adapter, which is what it did.
 */
export const home = (opts: { deleted?: boolean } = {}): string => `${CHROME}
<main>
  <button data-testid="composeFAB" aria-label="New post">+</button>

  <div class="hidden" id="composer">
    <div data-testid="composerTextInput" role="textbox" contenteditable="true"></div>
    <div id="extra"></div>
    <button data-testid="addQuoteBtn" aria-label="Add new post">+ post</button>
    <button data-testid="composerPublishBtn">Publish</button>
  </div>

  ${opts.deleted ? '' : `
  <div data-testid="feedItem-by-dana.bsky.social">
    <a href="/profile/dana.bsky.social/post/abc123">2h</a>
    <span data-testid="postAuthorName">dana</span>
    <div data-testid="postText">shipped the retry loop, it was the timeout all along</div>
    <button data-testid="likeBtn">like</button>
    <button data-testid="replyBtn">reply</button>
    <button data-testid="postDropdownBtn">...</button>
  </div>`}
  <div data-testid="feedItem-by-marco.bsky.social">
    <a href="/profile/marco.bsky.social/post/def456">4h</a>
    <span data-testid="postAuthorName">marco</span>
    <div data-testid="postText">anyone else seeing cold starts double this week</div>
    <button data-testid="likeBtn">like</button>
    <button data-testid="replyBtn">reply</button>
  </div>

  <div role="menu" class="hidden" id="menu">
    <div data-testid="postDropdownDeleteBtn" role="menuitem">Delete</div>
  </div>
  <div class="hidden" id="confirmBox"><button data-testid="confirmBtn">Delete</button></div>
</main>
<script>
  // Every handle is an explicit querySelector, never a bare id-global. The first
  // version of this file leaned on implicit globals (composeFAB.onclick = ...)
  // while the elements only carried data-testid — so the very first line threw
  // ReferenceError, no handler was ever attached, and eight checks failed
  // against an adapter that was fine.
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const composer = $('#composer');

  window.__thread = [];
  $('[data-testid="composeFAB"]').onclick = () => composer.classList.remove('hidden');

  $('[data-testid="addQuoteBtn"]').onclick = () => {
    // Each added post gets its own editor, and the adapter must type into the
    // NEWEST one — not the first, which already holds part 1.
    const d = document.createElement('div');
    d.setAttribute('data-testid', 'composerTextInput');
    d.setAttribute('role', 'textbox');
    d.setAttribute('contenteditable', 'true');
    $('#extra').appendChild(d);
  };

  $('[data-testid="composerPublishBtn"]').onclick = () => {
    window.__thread = $$('[data-testid="composerTextInput"]').map((e) => e.innerText);
    window.__posted = window.__thread.join('\\n---\\n');
    composer.remove();
  };

  for (const b of $$('[data-testid="likeBtn"]')) {
    b.onclick = () => {
      window.__liked = b.closest('[data-testid^="feedItem-by-"]').getAttribute('data-testid');
      b.setAttribute('data-testid', 'unlikeBtn');
    };
  }
  for (const b of $$('[data-testid="replyBtn"]')) {
    b.onclick = () => {
      window.__replyingTo = b.closest('[data-testid^="feedItem-by-"]').getAttribute('data-testid');
      composer.classList.remove('hidden');
    };
  }

  const menu = $('#menu');
  const dropdown = $('[data-testid="postDropdownBtn"]');
  if (dropdown) dropdown.onclick = () => menu.classList.remove('hidden');
  $('[data-testid="postDropdownDeleteBtn"]').onclick = () => {
    menu.classList.add('hidden');
    $('#confirmBox').classList.remove('hidden');
  };
  $('[data-testid="confirmBtn"]').onclick = () => {
    window.__deleted = true;
    // Tells the harness to stop serving the post, so the adapter's "is it
    // really gone" reload has something true to find.
    fetch('/selftest/bsky-deleted');
  };
</script>`;

/** One post on its permalink page. `liked` starts it already liked. */
export const post = (opts: { liked?: boolean } = {}): string => `${CHROME}
<main>
  <div data-testid="feedItem-by-dana.bsky.social">
    <div data-testid="postText">churn is a distribution problem</div>
    <button data-testid="${opts.liked ? 'unlikeBtn' : 'likeBtn'}" id="like">like</button>
    <button data-testid="replyBtn" id="reply">reply</button>
  </div>
  <div class="hidden" id="replyBox">
    <div data-testid="composerTextInput" role="textbox" contenteditable="true"></div>
    <button data-testid="composerPublishBtn">Publish</button>
  </div>
</main>
<script>
  const $ = (sel) => document.querySelector(sel);
  const like = $('#like');
  if (like) like.onclick = () => { window.__liked = true; like.setAttribute('data-testid', 'unlikeBtn'); };
  const replyBox = $('#replyBox');
  $('#reply').onclick = () => replyBox.classList.remove('hidden');
  replyBox.querySelector('button').onclick = () => {
    const t = replyBox.querySelector('[contenteditable]').innerText;
    window.__reply = t;
    $('main').insertAdjacentHTML('beforeend', '<div>' + t + '</div>');
  };
</script>`;

/** A profile, for follows. */
export const profile = (opts: { following?: boolean } = {}): string => `${CHROME}
<main>
  <div data-testid="profileHeaderDisplayName">Dana</div>
  <div data-testid="profileHeaderDescription">building things in public</div>
  <button data-testid="${opts.following ? 'unfollowBtn' : 'followBtn'}" id="f">
    ${opts.following ? 'Following' : 'Follow'}
  </button>
</main>
<script>
  const f = document.querySelector('#f');
  f.onclick = () => {
    window.__followed = true;
    f.setAttribute('data-testid', 'unfollowBtn');
    f.textContent = 'Following';
  };
</script>`;

/** Signed out. */
export const signedOut = (): string => `${CHROME}<main><h1>Sign in</h1></main>`;
