# Website activation (first-run and later Websites)

Routes: `/onboarding/:projectId/website`, `/onboarding/:projectId/install`,
`/onboarding/:projectId/verify`

Promoted from the approved local lab `/local-labs/onboarding`
(`docs/specs/onboarding-reference-lab.md`, local-only). The lab stays on disk
for motion tuning; this is the shipped flow.

## Shape

One shell, three screens. Each screen is its own route file so it is
deep-linkable, Back is ordinary browser history, and each shows up as its own
node on the October canvas. The shell (`onboarding-shell.tsx`) owns everything
that must survive a step change: the website draft, its internal installation
key, the camera's focus, the progress rail, and the frame that tweens between
screens of different heights.

On desktop, the shared left step frame starts at `20svh`, aligned with the real
dashboard header line inside the preview. Because the shell owns this frame,
Website, Install and Verify keep the same vertical start. Below `lg`, the preview
is hidden and the step frame keeps its compact `19svh` position.

Every route carries the project id. The shell and its access guard resolve that
exact project instead of selecting the first project in the account. This is
what makes the same flow safe for a new account, a later Workspace, and another
Website inside an existing Workspace.

- `onboarding-shell.tsx` — layout route: split pane, rail, shared state
- `onboarding-website-step.tsx` — step 1
- `onboarding-install-step.tsx` — step 2
- `onboarding-verify-step.tsx` — step 3
- `onboarding-stage.tsx` — the per-step frame (slide + staggered reveal)
- `onboarding-preview.tsx` — the dashboard preview and its camera
- `install-targets.ts` — step 2's stack table: file, placement, and snippet shape
- `onboarding-motion.ts` — the storyboard; every timing and value lives here
- `onboarding-website.ts` — dashboard helpers around the shared website schema
- `onboarding.css` — the three keyframe sequences and the preview canvas

## User-facing contract

Onboarding describes only what the person needs to do: add a Website, copy its
installation script, and check the connection. Recorder keys remain an internal
implementation detail and never appear in onboarding headings, support text,
loading labels, success states, or recoverable errors.

For the untouched Workspace created at first sign-in, step one says **Add your
first website**. The first valid Website gives that Workspace its default
hostname name. For an existing Workspace, step one names the destination, such
as **Add a website to Noodle**, and explains that related subdomains remain in
one visitor journey.

### Step two names the file, per stack

The loader is one inline tag, so the only thing a visitor is really asking on
step two is where it goes in _their_ project. So the step opens with a stack
picker (`install-targets.ts`), and the answer follows the selection:

| Stack   | File             | Placement                                    |
| ------- | ---------------- | -------------------------------------------- |
| HTML    | every page       | before `</head>`                             |
| React   | `index.html`     | before `</head>` (Vite and Create React App) |
| Next.js | `app/layout.tsx` | `next/script` at `beforeInteractive`         |
| Vue     | `index.html`     | before `</head>` (Vite)                      |
| Svelte  | `src/app.html`   | before `%sveltekit.head%` (SvelteKit)        |

HTML leads and is the default, because it is the only instruction true on every
stack: a visitor on something we do not list still reads a correct one. The file
titles the code card, carrying its file-type mark, which answers the question in
the space a "Installation script" label used to occupy. Next.js is the one target
whose **code** differs, not just its file: App Router owns script ordering, so
Copy hands over the `next/script` form with the loader body inside a template
literal.

### Step two can hand the install to a coding agent

The manual snippet stays the first artifact. Directly under its expander, **Use
your coding agent** repeats the same visual grammar: artifact name and Copy in
one row, a collapsed prompt preview, and a **View full prompt** disclosure. The
in-family `CodingAgent` glyph is purple so the agent handoff is distinguishable
from the selected stack's file mark; Copy keeps the same Copy to Copied treatment
as the snippet button. This is not another top-level card and does not add an
onboarding step.

A centred **or** pill with paired dashed rules separates the manual script from
the agent handoff. It makes the relationship explicit: these are two complete
ways to perform the same installation, not two tasks the visitor must finish.

The collapsed prompt is key-safe. It shows the task, selected stack and file,
then confirms that the script tag and exact steps are included. **View full
prompt** explicitly reveals the complete loader, framework instructions and
verification checklist, just as **View full code** reveals the complete script.
Opening either full view closes the other so the fixed onboarding column never
holds two expanded code surfaces. Copy always puts the full prompt on the
clipboard, whether its preview is collapsed or expanded.

`buildAgentInstallPrompt` owns that clipboard contract. Every prompt includes
the exact raw `<script>` tag, the selected stack, suggested file, placement,
duplicate-install guard, unrelated-file boundary, focused verification, and a
request to report the changed file without repeating the recorder key. Next.js
also receives the exact `next/script` form at `beforeInteractive`, so an agent
does not paste a raw inline tag into JSX. Switching stacks clears both copy
success states because both clipboard values have changed. A failed agent copy
says **Could not copy the agent prompt. Try again.** rather than asking the
visitor to select text that is deliberately hidden.

### Step two has no Continue

There is nothing to confirm. Step two polls `/install-status` under the snippet
— the same query, interval and "not while the tab is hidden" rule the verify
step uses — and hands over to step three by itself the moment an event lands.
`OnboardingStage` takes a null `action` for this and skips that chunk entirely,
so the column ends after the two installation choices rather than at 24px of
empty space. The waiting that used to justify a third screen is shown in the
preview, not restated in the form column. A visitor on this step sees the snippet
on the left, and on the right the Install page's own verify card saying it is
waiting for the first event.

Step two has **no supporting line**. The picker already names the file and the
placement, so a sentence under the heading only agreed with the instruction two
rows below it and spent a chunk of a 394px column doing so. `OnboardingStage`
takes `support` as optional for exactly this. Copy is `secondary`, not ghost:
copying is the step's whole job, so it reads as a control. It stays off the
light-filled primary plate, which belongs to Continue.

The collapsed card states the exact byte count of what Copy will paste. It is a
real number from the built snippet, not a rounded claim, and it is what lets the
card stay collapsed on a step whose only job is "copy this". The card scrolls
through the shared `ScrollArea` with `scroll-fade`, the same construction as the
Install page's code card, and it overrides Base UI's inline
`min-width: fit-content` on the content wrapper: this scroller is vertical only,
so a minified one-line loader has to wrap rather than lay out sideways past a
scrollbar that does not exist. The same override is missing on the Install page's
card, where the loader overflows the same way.

The picker renders outside the skeleton, so a visitor can find their stack while
the installation script is still being prepared. Switching stacks clears any
"Copied" badge, which would otherwise claim that a different snippet is on the
clipboard.

Repeating an unfinished Website returns the same installation script. Repeating
an already-connected Website does not silently redirect and does not create a
replacement: the screen says that the Website is already connected, confirms
that no new installation was created, and offers **Go to dashboard** or **Add
another website**. A direct or refreshed install link confirms the Website in
the background too, so a connection completed in another tab reaches that same
state instead of showing stale setup.

## Website address and favicon contract

`packages/shared/src/website-url.ts` is the one Zod boundary used by both the
dashboard form and the Worker favicon route. A bare domain such as `acme.com`,
an address beginning with `www`, or a scheme-relative address is normalized to
HTTPS. Explicit HTTP and HTTPS addresses, ports, paths, query strings, IPv4,
IPv6, and localhost remain valid when the browser URL parser accepts them.
Other schemes, credentials, whitespace, invalid hostnames, overlong values, and
names that cannot fit the project name contract are rejected. The form maps
those issues to its existing plain-English error instead of exposing schema
messages. The repo already uses Zod, so this did not add Valibot or a second
validation system. A non-empty invalid draft waits for one quiet second before
showing that error and replaying the transitions.dev shake. Continue and Enter
still validate immediately, and the error clears as soon as the visitor edits
the address again.

The authenticated `GET /api/v1/favicon?website=...` route uses that same schema.
It reads a site's declared icon links, prefers scalable or larger icons, and
falls back to `/favicon.ico`. Every request and redirect is capped and checked;
private/local targets, oversized bodies, unrecognised image types, mismatched
image bytes, credentials, excess redirects, and slow responses are refused. If
no safe icon is available, the Worker returns a generated amber initial rather
than a broken image.

The final response is cached in Cloudflare's local edge cache by normalized
website origin only when a real icon was fetched and verified. Verified icons
are cached for seven days. Generated initial-letter fallbacks use `no-store` and
are never written to Cloudflare's edge cache, so every later request can try the
website again. The dashboard URL and Worker edge key share a cache version,
allowing old browser and edge entries to be invalidated together.
A per-user Cloudflare rate-limit binding applies only to cache misses. The 16px
favicon in the field and the real project switcher share the same debounced URL.
Before a valid source exists, the favicon has
zero width and cancels the parent's gap, so the field never shows a dark
placeholder dot or reserves empty space. On step one, the right-side preview
mirrors only the live field: clearing the field immediately restores “Your
website” and removes the old favicon instead of reviving the saved project
identity. Steps two and three have no website field, so a direct visit may use
the saved identity there. A valid source drives one integer through empty,
loading, and revealed stages: the slot grows left-to-right while clearing a
brief blur, then uses the requested skeleton-to-content reveal when the image
finishes loading. A changed origin resets that sequence before paint; an
unchanged origin keeps its current icon.

## What each step writes

| Step      | Request                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| 1 Website | `PUT /api/v1/projects/:id/websites` — idempotently creates or reuses one Website and its key |
| 2 Install | `GET /api/v1/projects/:id/websites/:websiteId` — restores the same unfinished setup          |
| 3 Verify  | `GET /api/v1/projects/:id/websites/:websiteId/install-status`, polled every 3s               |

The first accepted ingest batch writes `first_event_at` and `first_session_id`
to the exact `project_websites` row attached to its key. Both use `COALESCE`, so
retries or concurrent batches cannot replace the first truth. Install status
returns both values; an older Worker response without the id safely decodes it
as `null`, which means the dashboard uses the cap instead of accepting an
unrelated session. Migration `0024_project_website_first_session.sql` adds the
column and is mirrored byte-for-byte into the self-host template.

### Why step 1 is not cosmetic

`bootstrapAccount` creates an internal project, shown as a Workspace, with
`allowed_origins = "[]"`. The ingest path treats an empty allowlist as "allow
nothing" (`browserOriginIsAllowed`). Step 1 creates a Website below that
Workspace, stores its exact origin boundary, and gives that Website its own
recorder key. It also adds those origins to the legacy Workspace-wide union so
existing settings and older manual keys remain compatible.

The allowlist gets both the typed origin and its `www` sibling. Ingest matches
origins exactly and the same list drives the CORS response, so a one-entry list
would leave step 3 waiting on an event the ingest path had already refused.

### Workspace naming

The first Website replaces the old `Default project` label with its readable
hostname. Adding later Websites does not rename the Workspace. The user can
therefore treat the Workspace as the product name while each Website remains a
separate recording source. The generated hostname is only the default; Settings
can rename the Workspace to its product name, such as Noodle.

### Recorder keys

Recorder keys are the developer-side installation boundary; onboarding calls
the result an installation script and hides the key itself. Each Website has
one active onboarding key. Step 1 creates it once. Repeating the request for the
same normalized origin returns that Website and key instead of creating
another, including requests from another tab. The raw value is encrypted
server-side with `WEBSITE_KEY_WRAP_SECRET` only while setup is unfinished, so
step 2 can recover the same snippet after a refresh or direct link. The browser
also keeps a tab-scoped copy for the normal fast path while confirming current
Website status with the server once per mount.

After the first accepted event for that Website, D1 stores its connection time
and deletes the encrypted raw value. The key remains active for recording, but
the dashboard can no longer read its secret. Returning to onboarding for a
connected Website therefore never mints a replacement or reveals that key.
The existing page-shaped skeleton covers the short setup fetch, then reveals
the real snippet.

## Reachability

`/onboarding` is a client route, so four separate lists have to name it or a
direct visit, a refresh or a shared link 404s: `isDashboardAppRoute` in
`apps/worker/src/app-shell.ts`, `run_worker_first` in
`apps/worker/wrangler.jsonc`, the same list in `infra/template/wrangler.jsonc`,
and the integrated dev server's copy in `apps/dashboard/vite.config.ts`.
`safeReturnPath` also allows onboarding paths, so a visitor bounced to login
returns to the step they were on.

`scripts/dashboard-spa-routes.test.mjs` derives the required set from
`router.tsx` and fails if any of the four drifts, including whether a route
needs the wildcard form. It also asserts `/local-labs` stays out of production
routing.

## Entry and exit

`openProjectsHome` asks `decideProjectsHome` for `check-activation`, reads
`/install-status`, and routes to `/onboarding/:projectId/website` only when it
knows no event has ever arrived. Two rules keep the guard from stranding anyone:

- **Only a manageable project is sent to activation.** Activation rejects a
  member-only project, so routing one there is an infinite redirect between
  `/projects` and `/onboarding`. A member-only project opens instead.
- **An unknown activation state opens the project.** A failed `/install-status`
  check is not read as "not activated". Step 1 replaces the project's origin
  allowlist, so treating a Presence 503 as "not activated" would let a routine
  outage walk an owner into overwriting a working install.

`requireActivationAccess` applies the same manageability rule, so the two cannot
disagree. It deliberately allows an already-active Workspace to open
onboarding because that is how an owner adds its second or later Website.
Reaching step 3 and seeing this exact Website connect starts the normal ending.
The Worker stores the first accepted session id on that Website. The dashboard
walks the preview to Live in its watching state and polls until that exact
session appears. It then shows the **Live now** payoff for 900ms, runs the 560ms
preview cut, and opens `/projects/:id/live`. A 4s cap prevents a stuck handoff;
the real Live page then continues with **Connecting to your live session…** for
the short handoff window while its normal query keeps polling. The button remains
available to leave immediately.

### Adding another Workspace or Website

The Workspace switcher shows the first Website's favicon beside its user-facing
name. The menu lists Workspaces normally, then places **Add website** and
**Add workspace** in a separate, quietly tinted **Create** section. Nothing is
added beside the switcher, so these occasional setup actions stay inside the
place they affect. Choosing **Add workspace** sends `POST /api/v1/projects` with
the active account-workspace id. The
Worker checks that exact workspace membership, creates a project with the same
safe defaults as account bootstrap (`allowed_origins = "[]"`, no recorder
keys), and creates the empty analytics bootstrap receipt in the same D1 batch.
The response contains the new project and refreshed account, so the dashboard
updates its account cache before navigating to that project's website step.

**Add website** opens the same onboarding flow for the current Workspace
without creating a new Workspace. The Website API uses a unique
`(project_id, origin)` row and a unique active Website-key index, so retries and
parallel tabs cannot create duplicate Websites or recorder keys. The screen
names the current Workspace so the person knows where the Website will appear.

Settings also starts on a **Websites** section. It shows every Website with the
same favicon, origin, and truthful Connected or Setup needed state. Its Website
URL field uses the same forgiving URL validation and favicon preview as
onboarding. Submitting a new Website prepares its one installation key and
continues directly to the existing install step; retrying an existing pending
Website reuses its key.

Both actions are hidden for members, the public demo, and the inert dashboard
preview inside onboarding.

## Cross-subdomain journeys

All Website keys inside one Workspace receive the same `sessionScope`. For
HTTPS Websites, the Worker uses the public suffix list to derive the safe
registrable cookie domain. `app.example.com` and `checkout.example.com`
therefore share one Workspace session even if either subdomain is added first.
Private suffixes such as `github.io` are handled as boundaries too. Localhost,
IP addresses, HTTP Websites, and unrelated root domains keep host-only cookies.
Recorder batches and the final session manifest keep every Website id observed
in that journey.

## Motion

### Three acts, one integer

The right pane is the same dashboard on all three screens, so the flow reads as
one continuous shot. `ACT` in `onboarding-motion.ts` is the single integer that
drives it, derived by `onboardingAct(stepIndex, isRecording)`:

- **ACT 0 IDENTITY** — the project takes your site's name. Typing zooms the
  camera in; blurring releases it.
- **ACT 1 PROMISE** — the camera rests wide: the whole dashboard, empty, held
  across install and while waiting, so the left pane carries the step. The
  camera does not move again, but the preview walks the tab row to whichever
  page the open step is about — see
  [The preview changes page](#the-preview-changes-page).
- **ACT 2 LIVE** — the first event lands. The frame lifts 10px and its shadow
  deepens while the preview walks to Live in its real signal-watch state. The
  watch gives way to the **Live now** badge and one session row only after Live
  returns the exact first session stored for this Website. Still no invented
  numbers or visitor details. Reaching this act outranks the step, so stepping
  Back does not take the state away.

The steps are separate routes and cannot see each other, so the verify step
reports the first event up into the shell rather than animating the preview
itself. Naming stays a transient override rather than a rung on the ladder, so
someone who steps Back to change their website after connecting still gets the
zoom.

The storyboard in `onboarding-motion.ts` is the authority. Vocabulary is
transitions.dev's, expressed with this codebase's bounce-free springs and
framer-motion rather than its CSS variables:

- step change — "page side-by-side": 8px travel along the direction of travel,
  3px cross-blur, 250ms, and the reference `cubic-bezier(0.22, 1, 0.36, 1)`.
  Back travels the other way.
- within a step — "texts reveal": 12px rise with a cross-blur, staggered in
  reading order, tightened from the reference so the primary action is legible
  by the time the pointer arrives.
- form frame — "card resize": the shell's persistent frame owns the height
  tween, because a routed step cannot keep a ghost copy mounted to cross-fade
  against.
- copy control — transitions.dev's text-states swap for the label (the old word
  leaves upward through a blur, the new one arrives from below) and its success
  check for the glyph (fade, unrotate from 80deg, unblur, bob, and the tick draws
  its own stroke). `CopyCheck` is `Copy` with the tick added in front, so only
  that first path draws and the frame never redraws or shifts. The check's
  entrance waits out the copy glyph rather than overlapping it: both carry the
  same frame, and a cross-fade under the rotate showed it twice at two angles.
  Green carries the state statically; the animation is only how it arrived.
- first event — a stroke-drawn check clearing an 8px blur.
- invalid URL — after one quiet second, transitions.dev's 280ms decaying shake
  and error-message fade; submit keeps the same immediate feedback.
- favicon — a 250ms left-to-right slot entrance, followed by transitions.dev's
  skeleton reveal clearing a 2px blur over 400ms.
- installation script — page two first paints a one-pulse skeleton shaped like
  its file title, code card, and Website note, then cross-fades and clears a 2px blur
  over 400ms when setup is ready. The skeleton and controls share one slot, so
  the persistent form frame does not jump.
- code card resize — transitions.dev's card-resize recipe tweens the card between
  its two fixed heights. This animates a layout property against the usual
  advice, deliberately: framer-motion's `layout="size"` fakes the size with a
  transform, and measuring it mid-flight caught the card at `scaleY(0.80)` with
  its children uncorrected, squashing the code text by a fifth as it grew. One
  card with two known heights is a cheap reflow; distorted code is not a cheap
  defect. The Install page's card has the same tell.

- preview page change — the product's own `top-nav-notch` layout animation,
  driven from onboarding rather than re-tuned for it, and the arriving page body
  cross-fading with a 6px rise. No blur: the left column's chunks clear one
  because they are text being read, and blurring a picture of a page reads as
  the camera losing focus.
- Live page filling — the same card-resize recipe as step two's code card,
  between two known heights, with the badge and row rising 8px as the signal
  watch fades. The watch's own rings and beacon are the Live page's, unchanged.

Reduced motion collapses every one of these: each component passes
`initial={false}` and a zero-duration transition, and every CSS keyframe and
transition sequence is disabled in a `prefers-reduced-motion` block. The tab
notch is included — `AppShell` guards its own spring, which it did not before
onboarding started driving that notch across five tabs without a click.

### The preview changes page

The camera holds still through acts 1 and 2, so what the right pane says on
steps two and three is _which page it is parked on_. `previewPage(stepIndex,
isRecording)` is that value, and one value drives both the tab row and the body
for the same reason `ACT` is one integer: the steps are routes and cannot see
each other, so anything derived per-step drifts.

- **Step 2 → Install, and Install carries the wait.** 180ms after the step's
  heading lands, the notch travels Overview → Install and the body cross-fades
  in with a 6px rise. The page under it is not a picture of where the snippet
  lives — it is that page in the state step two is actually in. The real Install
  page pairs its snippet card with a **Live verify** card that polls for the
  first event, so the waiting state this flow needs is already the product's
  own: the spinner, "Waiting for the first event…", and "Open a page with the
  snippet installed. This updates the moment data arrives."
- **Those two sentences are borrowed, not written.** They are copied verbatim
  rather than imported, because `InstallStatus` fetches, polls and renders
  alerts, and mounting it would put a live query inside a picture.
  `onboarding-preview-copy.test.ts` reads `install-status.tsx` and fails if the
  product changes the words, which turns drift into a failing test instead of a
  quiet lie. Everything else in the body stays placeholder geometry.
- **The two cards are stacked, not side by side.** The real page uses that
  arrangement below `lg` and a two-column grid above it. The preview frame crops
  at about 78% of the stage, which would put the verify card — the card this
  whole step is waiting on — mostly outside the frame, so the preview borrows
  the product's own narrow arrangement rather than inventing a layout.
- **The event, and only the event, moves it to Live.** Nothing else does: not
  copying, not a step change. The page arrives in its signal-watch state. The
  **Live now** badge and one session row replace it only when the exact first
  session for this Website is present. The frame lifts before the page change.
- **Why Live can show this when Overview cannot.** Every metric on Overview
  needs a finalised session to be true, which is why the preview shows none of
  them. A row on Live claims only that a session exists — which is exactly what
  just became true. It is the one page in the product that can be honest seconds
  after an install.
- **The row still invents nobody.** Onboarding knows an event arrived, not who
  sent it, so the path, place and elapsed time stay placeholder bars. The badge
  is the product's own `LiveBadge` component rather than a retyped string.
- **It is a real wait with exact identity.** The install-status response carries
  the session id captured by the first accepted Website batch. The verify step
  ignores every other project-wide Live row and fills the preview only when that
  exact id appears. It seeds the same Live query cache, holds the payoff for
  `VERIFY.payoffHold`, then cuts. Its request is aborted when the step unmounts.
- **The cap stays honest.** `VERIFY.handoffCap` (4s) prevents a slow, empty or
  failing query from stranding anyone. The cap marks a short handoff state before
  the cut, so an empty real Live page says **Connecting to your live session…**
  instead of claiming nobody is browsing. Reduced motion keeps the same
  confirmed-or-cap rule but skips both presentation delays.
- **A direct link parks, it does not travel.** The first value is adopted with
  no delay, because a refresh or shared link straight to a later step has no
  travel to show.

### The wait rings, and the arrival is staged

Two things the pane did not do before, both about the same problem: the wait was
dead and the arrival was crowded.

- **One ring per poll.** Step two can last minutes, and a spinner that never
  stops stops being read after the first second. The verify card now sends a
  single amber ring out from its spinner each time the poll actually completes —
  fired by `dataUpdatedAt` moving, not by a loop — so it means "I just checked,
  and I will check again in three seconds". The stillness between rings is what
  makes each one land. Measured in Chromium at exactly 3.00s intervals, one ring
  per request.
- **The arrival has one subject per beat.** It used to change the tab, fill the
  page and lift the frame at once, which meant none of the three was read. Now:
  at 0ms the card the visitor is already watching takes the Install page's real
  **Installed** state, green dot and all; at 260ms the frame lifts; at 420ms the
  tab row travels to Live in its watching state. When the exact session appears,
  the card fills. Cause and effect, left to right: it worked → the dashboard
  reacts → the session is really here.

### The exit: the picture becomes the thing

After the exact session appears, the filled card holds for 900ms so the payoff
can be read. The frame then grows to cover the viewport over 560ms while the form
column slides 16px and fades out in 320ms. The route changes behind a frame that
already fills the screen, so the last thing the flow does is an arrival rather
than a page change.

The transform is measured from the frame's own box against the window at the
moment it starts: the frame is sized in svh and percentages against a pane that
is a fraction of the grid, so there is no arithmetic that yields it. The lift is
added back, or the corner lands 10px low. Both are applied about
`transform-origin: 0 0`, the same corner the stage inside already scales from.
Two things are dropped for the duration: the pane's clip, or the frame cannot
grow past it, and the frame's bottom fade, which is a device for dissolving a
cropped picture into a pane and is just a dark band once the picture covers the
screen.

An alternative was built and compared against it — a "Getting your dashboard
ready" line rising out of the fade over an unmoved frame, then a plain route
change. It was the safer of the two and read as a caption on a picture you were
about to leave, which is the opposite of what the last beat is for. It is gone,
along with the toggle that switched between them.

What remains from that comparison is `OnboardingExitRehearsal`: a development-only
**Play exit** control that plays the arrival and the exit against the current
screen and puts everything back. The exit is 560ms at the end of something that
happens once per website, so without it the only way to look at it is to install
a snippet and catch it. It never navigates and is not rendered in a production
build.

### The preview's card follows the stack picker

Step two's stack choice lives in the shell, not in the step, because the preview
mirrors it across a route boundary. Selecting a stack fills the left field of
the preview's snippet card with that stack's mark and name, and rewrites the code
block under it with that stack's real snippet — built by the same functions the
left column builds the real thing with, so Next.js differs in shape and not just
in a filename.

Two constraints on it:

- **The key is masked.** Keeping the raw key off screen until asked for is a
  decision step two already made — its card shows a byte count until **View full
  code** is pressed — and a second surface printing it by default would quietly
  undo that. Nothing else about the snippet is changed.
- **The code is clamped to 104px and masked out at the bottom.** The loader is
  about 1,900 characters; at 9px the whole thing is a wall of grey that stops
  reading as code. The fade says there is more without pretending there is not.

This is the one place the preview shows something the real Install page does not:
that page's first field is the recorder key, not a stack. It earns the exception
by being the thing the visitor is actively doing — a pane that does not move
while someone clicks through five tabs reads as a screenshot.

Copying reports up into the shell as a counter — step two owns the button and
the preview owns the card, and neither can reach the other, the same reason the
verify step reports the first event up. The preview answers with one sweep
across its snippet card. It claims nothing that is not already true: the snippet
really does live in that card on that page, and the sweep leaves the card
exactly as it found it.

## The preview

The right pane renders the **real `AppShell`** — the same header, project
switcher, environment badge, tab row and workspace card the dashboard ships —
inside a fixed 1100×1080 stage that a camera scales and translates. It is
`inert` and `aria-hidden`, so none of its links or controls are reachable. Three
optional `AppShell` props exist only for it: `projectLabel`, so the switcher
follows the field before the rename is saved; `projectLeadingContent`, so the
same favicon can appear in the switcher; and `rootClassName`, so the shell can
be framed by the stage instead of the viewport.

Only the page body is stand-in content, and it carries **no copy at all**. The
tab row keeps its real labels because those name where the visitor is about to
go, and the header keeps the switcher because that is the camera's subject;
everything below is placeholders.

That is the third answer to the same question. Rendering invented labels promised
things the product does not ship. Rendering the Overview page's real labels
worked but meant policing them against the product forever. Rendering none
claims nothing, so the honesty problem goes away by construction, and
`onboarding-preview-copy.test.ts` now asserts the body reproduces no product
copy rather than that it matches it.

The placeholders are deliberately static: a perpetual pulse competed with the
camera move, and "still waiting" is carried in words by the verify step's status
card, which is where it belongs. They use `--surface-8`, the theme's lightest
surface step, so they read as a loader against the card without inventing a
colour, at a 3px radius. The thin bars are 10px rather than 8 because a pill
needs a radius of half the height, so at 8px a 3px radius never shows a flat
side. Their widths are proportional to the real labels they replace, which is
what keeps the metric band from reading as four identical grey rectangles.

While the website field is being named, the camera pushes in on the project
switcher and the switcher lifts onto its own surface. The camera is gated to
step 1, because submitting with the keyboard never blurs the field.

The lift is a CSS rule in `onboarding.css`, and the control it styles belongs to
`AppShell`, so the only thing joining them is a selector. That hook is
`data-shell-switcher` on the shell's trigger — an attribute with no other
purpose. It used to be the trigger's `aria-label`, and renaming that "Project" →
"Workspace" took the whole highlight away with nothing failing;
`onboarding-camera-hook.test.*` now guards both ends of the join.

### Depth: the camera moves, it does not magnify

A zoom changes focal length and every plane magnifies together; a camera that
physically moves makes near planes travel further than far ones, and that
parallax is most of what separates a dolly from a zoom.

The frame paints the dotted canvas and the frame never scales, so the grid used
to sit completely still while the dashboard grew 29% over it. A background that
ignores the camera reads as content sliding on glass. The grid is now its own
layer (`.onboarding-canvas-grid`) taking `CAMERA.parallax.canvas` (0.35) of the
dashboard's magnification, on a transform rather than `background-size`, because
`background-size` is not GPU-composited and would repaint a full-frame image on
every frame of the spring.

Two numbers are coupled there: the layer is inset `-12.5%` so it cannot expose
an edge when it grows, which makes it 125% of the frame, which puts the frame's
top-left corner at `10%` of the layer — and that is where its
`transform-origin` has to sit, because the stage scales from that same corner.
If the two planes do not share a vanishing point the background drifts
diagonally instead of receding. Change one number and the other must follow.

### Two depth devices this frame cannot afford

Both were tried or proposed and both are recorded here so they are not
re-proposed. They fail for the same reason: depth of field and differential
scale are both consequences of distance, and this frame has almost none to spend.

**Rack focus.** A 1px blur on the far plane shipped briefly and was reverted for
being invisible. The dotted canvas is 1px dots at 5% opacity showing across
roughly 5% of the frame, the rest hidden behind an opaque workspace card. A 1px
Gaussian spreads a single-pixel dot over about a 3×3 area and cuts its peak
intensity around ninefold, so blurring it does not soften anything — it erases
something that was never visible. Defocusing the card instead, while keeping the
header sharp, would invent depth between two surfaces a few pixels apart.

**A nav row plane.** Giving the top nav row a coefficient _above_ 1 so the
subject would separate from the body. It is wrong twice over.
The header sits flat on the canvas and the workspace card is a raised panel a few
pixels above it, so the two are effectively coplanar and any differential between
them is invented depth. Worse, its visible signature is a nav bar growing faster
than the page — which is the exact artifact this camera pass began by fixing. Had
the elevation been followed honestly, the raised card is the _nearer_ surface, so
the nav should grow more slowly and the subject would recede.

### Timing: a push and a pull-out are not the same move

`CAMERA.spring` (520ms) pushes in and `CAMERA.releaseSpring` (760ms) releases.
Film convention gives a reveal more time than the push that preceded it, and
with equal timings blurring the field read as the camera snapping back.

Act 2 staggers rather than firing together: the check strokes in on the left,
and `PREVIEW_FRAME.liveDelay` (180ms) holds the frame's lift back so the eye is
led left to right. Two moves running at once in two places give it nothing to
follow. The CSS shadow transition carries the same 180ms delay so the shadow
travels with the lift instead of ahead of it.

### The camera: a push toward the switcher, bounded by the brand

Rest sits flush at the frame's top-left. The push goes to `1.18` with a 24px
leftward bias, so it reads as travelling _toward_ the switcher rather than
enlarging everything from the corner.

The bias is capped by geometry, and the cap is the interesting part. The subject
sits 264px into the stage; the brand mark only 30px. Biasing far enough to hold
the switcher's screen column exactly would put the brand outside the frame — and
that is precisely the framing that was rejected earlier. `CAMERA.brandX` records
the constraint, and a test asserts `brandX * scale + x > 0` at both stops, so the
bound is encoded rather than remembered. At the shipped values the mark clears
the frame edge by about 11px, measured at 9px in the browser.

Scale history, because it took three tries. `1.42` filled the frame with chrome
and stopped reading as a dashboard (about 46% of its width visible). `1.01` came
from measuring a reference framing two ways off its own geometry so the retina
factor cancelled — the KPI band's height and its four-column pitch both gave
`2.02x` the unscaled stage in a 2x capture — and was the right correction, but
too timid once a highlight made a deeper push legible. `1.18` shows about 60% of
the width, keeping the metric band and behaviour card in frame.

`y` is zero at both stops and stays there: `y: 120` once pushed the header into
mid-frame behind a band of empty canvas, which read as the nav re-laying itself
out rather than as a camera move.

The tests assert invariants, not literals: rest is flush, the push is deeper and
biased left, the brand stays in frame, `y` never lifts the dashboard's top edge,
the scale stays under `1.3`, and the subject's drift stays under 110px — a bound
against the original 169px swing rather than an ideal, since some drift is
unavoidable once the bias is capped.

### The highlight is the system's own focus ring

While the website is being named, the switcher takes a 1px amber ring and an
amber bloom. Neither is invented: `--ring` and `--focus-ring` both resolve to
amber, `InputField` shows `ring-amber` on focus and `NumberStepper` on
focus-within, so amber at 1px already means "this control has attention"
throughout the product. The bloom is `.demo-scan-dot`'s
`0 0 8px var(--amber-shadow)`, opened to 14px because this control is far larger
than a 5px dot and has to read across the pane.

The point is the pairing. The website field the visitor is typing into is wearing
that exact ring at that exact moment, and so is the switcher that is about to say
what they typed — which is what connects the two halves of the screen.

Behind the ring sits `EmberField`, the shared LED lattice the settings dock and
the demo notch already use: 2px squares on a 5px pitch, each shimmering on its
own sine wave, coloured amber from CSS `color`. `SWITCHER_FIELD` places it in
unscaled **stage coordinates**, so it rides inside the stage and the camera
scales it with the dashboard — no measuring the switcher at runtime.

It runs far hotter than the toast field it borrows from, and the arithmetic is
why. `EmberField` gives 93% of its cells an alpha near `0.03 + 0.15 * random²`,
about `0.08`, which is invisible as amber on this canvas — and the default
shimmer moves that by `0.03`, a change nothing can perceive. At the component's
own defaults the field read as a handful of scattered static dots rather than a
lattice. `intensity: 2.2` lifts the quiet majority to about `0.18` and saturates
the bright 7%; `pulse: 1.6` pins shimmer depth at its `0.48` cap and doubles the
rate, so cells visibly travel between roughly half and full brightness.

Three constraints shape that box, and each has a test:

- **Centred on `CAMERA.target.x`** and wider than the 132px switcher, so the
  lattice reads around the chip rather than beside it.
- **Its bottom edge clears the switcher.** `EmberField` is brightest along the
  bottom and fades upward, so an edge landing inside the control would hide the
  brightest row behind a semi-opaque background. Ending just below it instead
  reads as light spilling from the chip.
- **It starts at the stage's top edge.** The switcher is only 10px down, so
  anything taller would be cut off by the frame rather than fading out.

A radial mask adds the horizontal falloff `EmberField` has no opinion about, the
same device `.live-dot__light` uses on its own pixel grid. The field mounts only
while naming so its `requestAnimationFrame` loop does not run for the whole flow,
inside an `AnimatePresence` so it still fades out. `EmberField` already draws a
single static frame under `prefers-reduced-motion`.

### Favicon connection

The lab's generated one-letter favicon is replaced by the fetched website icon
with an initial-letter fallback. `AppShell` and the shared Select accept optional
leading content, so onboarding can place the favicon in the real switcher
without changing the normal dashboard switcher. The input and preview therefore
show the same identity while the visitor types. Both surfaces use the same
three-stage empty/loading/revealed component, so neither reserves a blank slot
and both replay the loading blur when the visitor changes to a new origin.

## Verification

`vp check` reports zero errors (four pre-existing rrweb warnings remain) and
all tests pass. `apps/dashboard/tests/onboarding-activation.test.tsx` covers
the URL helpers, the origin allowlist including the port case, the step model,
the routing decision, all three steps' behavior, and the key-minting rules.
The worker route is covered end-to-end in
`apps/worker/tests/api-recordings-projects.test.ts`, and its access matrix
entry in `apps/worker/tests/dashboard-request-policy.test.ts`.

The favicon follow-up adds shared valid, invalid, trimmed, and boundary coverage
in `packages/shared/tests/website-url.test.ts`; bounded fetch, redirect, image
validation, fallback, cache, and rate-limit coverage in `apps/worker/tests/favicon.test.ts`;
and signed-in-only routing coverage in `dashboard-request-policy.test.ts`.
`onboarding-activation.test.tsx` also protects the bare-domain submit, the
one-second typed-validation delay, immediate submit error, corrected retry,
shake trigger, page-shaped recorder-key skeleton and reveal, favicon reveal,
normalized API URL, and exact step-motion values. The NDLE regression adds a
Next.js query-string icon, a multi-size Windows ICO served as
`image/vnd.microsoft.icon`, the shared cache version, and proof that generated
fallbacks use `no-store` and never call `cache.put`.

Visual proof came from real Chrome against the existing dev server on 8787 with
`/api/v1/*` stubbed client-side; nothing was written to the local worker. Note
for future passes: that tab is hidden, so `requestAnimationFrame` is suspended
and framer-motion holds every element at its `initial` value — force the
settled state before judging, and judge end states only. The dev server's SPA
fallback answers every path, so it cannot prove the reachability lists above;
`dashboard-spa-routes.test.mjs` is what covers those.

The favicon follow-up used the existing authenticated Brave session on 8787
without request stubs. A real Google icon and the safe generated fallback each
appeared in both the input and project switcher; the invalid state and the next
step were also exercised. The NDLE regression was then repeated against its real
15,086-byte icon: the yellow dotted icon appeared in both surfaces, while the
Worker wide event reported `favicon_result: "fetched"`. This touched only the
local development project. No migration or deploy was run.

### Independent review, 2026-07-30

Reviewed by `gpt-5.6-sol` at `xhigh` effort, read-only, prompted to refute eight
specific claims rather than confirm them. It confirmed the authz path (with live
probes returning member 403, cross-project 403, demo 401), that `PROJECT_PATTERN`
changes no pre-existing route plan, that a rename touches no recorder config,
that `activationAllowedOrigins` holds for IPv4, IPv6, localhost, IDN/punycode,
ports, trailing dots, uppercase hosts and credential-bearing URLs, and that the
preview fires no dashboard queries.

It refuted two, and both are now fixed above: the guard treated an
install-status failure as "not activated" (which could walk a live project into
having its allowlist replaced), and a member-only first project produced an
infinite redirect. It also found the missing SPA route registration, which was
a ship-stopper: every first-run URL would have 404'd on refresh. Four smaller
findings were fixed too — the key-error retry posted a create when the read had
failed, step 1's writes were ordered so a partial failure left the worse state,
the direction ref was updated during render so Back animated forward, and an
over-long hostname enabled a Continue the API would refuse.
