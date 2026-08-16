/**
 * A fake LinkedIn, built from the DOM shapes `src/platforms/linkedin.ts` targets.
 *
 * These pages are served to a real Chromium by `scripts/selftest.ts`, which
 * intercepts every linkedin.com request. The adapter runs completely unmodified
 * against them — same selectors, same waits, same verification steps.
 *
 * WHAT THIS PROVES: that the adapter's selectors, click order, hover-then-pick
 * sequences, confirmation-dialog handling and success checks are internally
 * coherent, and that a failure returns a real reason instead of a false green.
 *
 * WHAT IT CANNOT PROVE: that these shapes are what LinkedIn serves today. They
 * are a reconstruction. A fixture passing is not a substitute for one supervised
 * run against a live session — it is what makes that run worth doing.
 *
 * Each page is interactive on purpose: Accept removes its card, Follow flips to
 * Following, Post closes the dialog. A test that only checks "the click landed"
 * would pass against a page where nothing happens.
 */

const CHROME = `
<style>
  body { font-family: system-ui; margin: 0; padding: 20px; }
  [role="dialog"] { border: 1px solid #ccc; padding: 16px; margin: 12px 0; }
  .hidden { display: none; }
  [contenteditable] { border: 1px solid #999; min-height: 60px; padding: 8px; }
</style>
<nav><img class="global-nav__me-photo" alt="me"></nav>
`;

/** The feed, including the composer the personal-post path drives. */
export const feed = (): string => `${CHROME}
<main>
  <div role="button" tabindex="0" id="starter">Start a post</div>

  <div role="dialog" class="hidden" id="composer">
    <div contenteditable="true" role="textbox" aria-label="Text editor for creating content"></div>
    <button id="audience">Post to Anyone</button>
    <button id="submit">
      Post
    </button>
  </div>

  <div class="feed-shared-update-v2" data-id="urn:li:activity:1000">
    <span class="update-components-actor__title">Dana Okonkwo</span>
    <div class="update-components-text">We cut onboarding from six steps to two.</div>
    <button aria-label="React Like" aria-pressed="false">Like</button>
    <button aria-label="Comment">Comment</button>
  </div>
</main>
<script>
  starter.onclick = () => composer.classList.remove('hidden');
  // The audience picker also contains the word "Post". Clicking it must not publish.
  audience.onclick = () => { window.__audienceClicked = true; };
  submit.onclick = () => {
    window.__posted = document.querySelector('#composer [contenteditable]').innerText;
    composer.remove();
  };
</script>`;

/** A company page's admin composer. Same shapes, different entry URL. */
export const pageComposer = (): string => feed();

/**
 * One post on its own permalink page.
 *
 * `reacted` starts the Like button pressed, which is how the adapter is meant to
 * notice it has already reacted and refuse rather than silently un-react.
 */
export const post = (opts: { reacted?: boolean } = {}): string => `${CHROME}
<main>
  <div class="feed-shared-update-v2" data-id="urn:li:activity:2000">
    <span class="update-components-actor__title">Priya Raman</span>
    <div class="update-components-text">Churn is a distribution problem, not a product one.</div>

    <button aria-label="React Like" aria-pressed="${opts.reacted ? 'true' : 'false'}" id="like">Like</button>
    <div class="reactions-menu hidden" id="flyout">
      <button aria-label="Celebrate">Celebrate</button>
      <button aria-label="Support">Support</button>
      <button aria-label="Insightful">Insightful</button>
    </div>

    <button aria-label="Comment" id="commentBtn">Comment</button>
    <div class="comments-comment-box hidden" id="commentBox">
      <div role="textbox" contenteditable="true"></div>
      <button class="comments-comment-box__submit-button">Reply</button>
    </div>

    <button aria-label="Repost" id="repostBtn">Repost</button>
    <div role="menu" class="hidden" id="repostMenu">
      <span id="repostNow">Repost</span>
      <span id="repostThoughts">Repost with your thoughts</span>
    </div>
  </div>

  <div role="dialog" class="hidden" id="shareComposer">
    <div contenteditable="true" role="textbox" aria-label="Text editor for creating content"></div>
    <button id="shareSubmit">
      Post
    </button>
  </div>

  <div id="comments"></div>
</main>
<script>
  like.onmouseenter = () => flyout.classList.remove('hidden');
  like.onclick = () => { like.setAttribute('aria-pressed', 'true'); window.__reaction = 'like'; };
  for (const b of flyout.querySelectorAll('button')) {
    b.onclick = () => {
      like.setAttribute('aria-pressed', 'true');
      window.__reaction = b.getAttribute('aria-label').toLowerCase();
    };
  }

  commentBtn.onclick = () => commentBox.classList.toggle('hidden');
  commentBox.querySelector('button').onclick = () => {
    const text = commentBox.querySelector('[contenteditable]').innerText;
    window.__comment = text;
    // The proof the adapter looks for is the comment's own words on the page.
    document.getElementById('comments').insertAdjacentHTML('beforeend',
      '<article class="comments-comment-entity"><span class="comments-comment-meta__description-title">You</span>' +
      '<div class="comments-comment-item__main-content">' + text + '</div></article>');
  };

  repostBtn.onclick = () => repostMenu.classList.remove('hidden');
  repostNow.onclick = () => { window.__repost = 'plain'; repostMenu.classList.add('hidden'); };
  repostThoughts.onclick = () => { repostMenu.classList.add('hidden'); shareComposer.classList.remove('hidden'); };
  shareSubmit.onclick = () => {
    window.__repost = document.querySelector('#shareComposer [contenteditable]').innerText;
    shareComposer.remove();
  };
</script>`;

/** A post that already has comments on it, for the reply path. */
export const postWithComments = (): string => `${CHROME}
<main>
  <div class="feed-shared-update-v2" data-id="urn:li:activity:3000">
    <div class="update-components-text">We shipped the thing.</div>
  </div>

  <article class="comments-comment-entity" id="c1">
    <span class="comments-comment-meta__description-title">Marco Silva</span>
    <div class="comments-comment-item__main-content">How long did the migration take end to end?</div>
    <button aria-label="Reply to Marco Silva">Reply</button>
  </article>

  <article class="comments-comment-entity" id="c2">
    <span class="comments-comment-meta__description-title">selftest-li</span>
    <div class="comments-comment-item__main-content">Thanks everyone for the kind words.</div>
    <button aria-label="Reply to selftest-li">Reply</button>
  </article>

  <div class="comments-comment-box hidden" id="replyBox">
    <div role="textbox" contenteditable="true"></div>
    <button class="comments-comment-box__submit-button">Reply</button>
  </div>
</main>
<script>
  for (const a of document.querySelectorAll('article button')) {
    a.onclick = () => { window.__replyingTo = a.closest('article').id; replyBox.classList.remove('hidden'); };
  }
  replyBox.querySelector('button').onclick = () => {
    const text = replyBox.querySelector('[contenteditable]').innerText;
    window.__reply = text;
    document.querySelector('main').insertAdjacentHTML('beforeend', '<div>' + text + '</div>');
  };
</script>`;

/** A profile, for visits and follows. */
export const profile = (opts: { following?: boolean } = {}): string => `${CHROME}
<main>
  <h1>Dana Okonkwo</h1>
  <div class="text-body-medium">Head of Platform at Northwind</div>
  <button aria-label="${opts.following ? 'Following Dana Okonkwo' : 'Follow Dana Okonkwo'}" id="follow">
    ${opts.following ? 'Following' : 'Follow'}
  </button>
</main>
<script>
  follow.onclick = () => {
    follow.setAttribute('aria-label', 'Following Dana Okonkwo');
    follow.textContent = 'Following';
    window.__followed = true;
  };
</script>`;

/** An authwall: HTTP 200, real-looking, and signed out. */
export const authwall = (): string => `${CHROME}
<main>
  <h1>Join LinkedIn</h1>
  <a href="/signup">Join now</a>
</main>`;

/** Pending incoming invitations. */
export const invitations = (): string => `${CHROME}
<main>
  <ul>
    <li class="invitation-card" id="i1">
      <a href="/in/aisha-bello"><span aria-hidden="true">Aisha Bello</span></a>
      <p class="invitation-card__subtitle">Founder, building in logistics</p>
      <button aria-label="Accept Aisha Bello's invitation">Accept</button>
      <button aria-label="Ignore Aisha Bello's invitation">Ignore</button>
    </li>
    <li class="invitation-card" id="i2">
      <a href="/in/tom-grady"><span aria-hidden="true">Tom Grady</span></a>
      <p class="invitation-card__subtitle">Growth Consultant | DM me for leads</p>
      <button aria-label="Accept Tom Grady's invitation">Accept</button>
      <button aria-label="Ignore Tom Grady's invitation">Ignore</button>
    </li>
  </ul>
</main>
<script>
  window.__accepted = [];
  for (const b of document.querySelectorAll('button[aria-label^="Accept"]')) {
    b.onclick = () => {
      window.__accepted.push(b.closest('li').id);
      // Accepting removes the card, which is exactly why the adapter must match
      // on the name rather than walking indices.
      b.closest('li').remove();
    };
  }
</script>`;

/** Invitations this account sent, newest first, with the age wording on the card. */
export const sentInvitations = (): string => `${CHROME}
<main>
  <ul>
    <li id="s1">
      Recent Person — Sent 3 hours ago
      <button aria-label="Withdraw invitation sent to Recent Person">Withdraw</button>
    </li>
    <li id="s2">
      Old Person — Sent 2 months ago
      <button aria-label="Withdraw invitation sent to Old Person">Withdraw</button>
    </li>
    <li id="s3">
      Older Person — Sent 5 months ago
      <button aria-label="Withdraw invitation sent to Older Person">Withdraw</button>
    </li>
  </ul>
  <div role="dialog" class="hidden" id="confirmBox">
    <p>Withdraw this invitation?</p>
    <button id="cancel">Cancel</button>
    <button id="confirmWithdraw">
      Withdraw
    </button>
  </div>
</main>
<script>
  window.__withdrawn = [];
  let pending = null;
  for (const b of document.querySelectorAll('li button')) {
    b.onclick = () => { pending = b.closest('li'); confirmBox.classList.remove('hidden'); };
  }
  confirmWithdraw.onclick = () => {
    window.__withdrawn.push(pending.id);
    pending.remove();
    confirmBox.classList.add('hidden');
  };
</script>`;

/** Your own activity feed, and the delete flow that runs off it. */
export const activity = (opts: { deleted?: boolean } = {}): string => `${CHROME}
<main>
  ${opts.deleted ? '<p>Nothing here yet.</p>' : `
  <div>
    <div>
      <div>
        <a href="/feed/update/urn:li:activity:2000">2h</a>
        <a href="/feed/update/urn:li:activity:2000">image</a>
        <div class="update-components-text">Churn is a distribution problem</div>
        <button aria-label="Open control menu" id="menu">More</button>
      </div>
    </div>
  </div>
  <div>
    <div>
      <div>
        <a href="/feed/update/urn:li:activity:1999">1d</a>
        <div class="update-components-text">An older post</div>
      </div>
    </div>
  </div>`}
  <div role="menu" class="hidden" id="controlMenu">
    <div role="menuitem" id="del">Delete post</div>
  </div>
  <div role="dialog" class="hidden" id="confirmDelete">
    <button id="doDelete">
      Delete
    </button>
  </div>
</main>
<script>
  if (window.menu) menu.onclick = () => controlMenu.classList.remove('hidden');
  if (window.del) del.onclick = () => { controlMenu.classList.add('hidden'); confirmDelete.classList.remove('hidden'); };
  if (window.doDelete) doDelete.onclick = () => { window.__deleted = true; fetch('/selftest/deleted'); };
</script>`;
