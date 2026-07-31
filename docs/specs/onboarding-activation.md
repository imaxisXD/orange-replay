# Activation (first-run onboarding)

Routes: `/onboarding/website`, `/onboarding/install`, `/onboarding/verify`

Promoted from the approved local lab `/local-labs/onboarding`
(`docs/specs/onboarding-reference-lab.md`, local-only). The lab stays on disk
for motion tuning; this is the shipped flow.

## Shape

One shell, three screens. Each screen is its own route file so it is
deep-linkable, Back is ordinary browser history, and each shows up as its own
node on the October canvas. The shell (`onboarding-shell.tsx`) owns everything
that must survive a step change: the website draft, the recorder key minted
this visit, the camera's focus, the progress rail, and the frame that tweens
between screens of different heights.

- `onboarding-shell.tsx` — layout route: split pane, rail, shared state
- `onboarding-website-step.tsx` — step 1
- `onboarding-install-step.tsx` — step 2
- `onboarding-verify-step.tsx` — step 3
- `onboarding-stage.tsx` — the per-step frame (slide + staggered reveal)
- `onboarding-preview.tsx` — the dashboard preview and its camera
- `onboarding-motion.ts` — the storyboard; every timing and value lives here
- `onboarding-website.ts` — pure URL → name / origins helpers
- `onboarding.css` — the three keyframe sequences and the preview canvas

## What each step writes

| Step      | Request                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| 1 Website | `PATCH /api/v1/projects/:id` (name), then `PUT /api/v1/projects/:id/config` (allowedOrigins) |
| 2 Install | `POST /api/v1/projects/:id/keys` — only when the project has no active key                   |
| 3 Verify  | `GET /api/v1/projects/:id/install-status`, polled at the shared 3s interval                  |

### Why step 1 is not cosmetic

`bootstrapAccount` creates a project with `allowed_origins = "[]"`, and the
ingest path treats an empty allowlist as "allow nothing"
(`browserOriginIsAllowed`). A freshly bootstrapped project therefore cannot
receive a single event until an origin is stored. Step 1 is what makes the
project able to record.

The allowlist gets both the typed origin and its `www` sibling. Ingest matches
origins exactly and the same list drives the CORS response, so a one-entry list
would leave step 3 waiting on an event the ingest path had already refused.

### Why the project is renamed

`PATCH /api/v1/projects/:id` is a new route: manager-only, mutation-origin
checked, body capped at 1 KB, name trimmed to 100 chars. The name is
display-only — it feeds no key, no R2 path and no query — so a rename never
bumps `config_version` or invalidates the recorder's cached config. A worker
test asserts exactly that.

### Recorder keys

A raw key is readable once, at creation. So step 2 mints the project's first
key itself and holds it in memory for the visit. If the project already has an
active key and the raw value is not in memory (a reload, or a returning
visitor), the step asks before creating another rather than stacking up keys.
The card summarises the loader by default and reveals the full text on request,
matching the Install page; the copied text is always the real snippet.

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
`/install-status`, and routes to `/onboarding/website` only when it knows no
event has ever arrived. Two rules keep the guard from stranding anyone:

- **Only a manageable project is sent to activation.** Activation rejects a
  member-only project, so routing one there is an infinite redirect between
  `/projects` and `/onboarding`. A member-only project opens instead.
- **An unknown activation state opens the project.** A failed `/install-status`
  check is not read as "not activated". Step 1 replaces the project's origin
  allowlist, so treating a Presence 503 as "not activated" would let a routine
  outage walk an owner into overwriting a working install.

`requireActivationAccess` applies the same manageability rule, so the two cannot
disagree. An already-activated project is not bounced out: reaching step 3 and
seeing the recorder connected is the flow's ending. Step 3's success opens
`/projects/:id/overview`.

## Step 1 write ordering

The two writes cannot be one transaction, so they are ordered by what a partial
failure leaves behind. The allowlist write goes first, because it is what lets
the project record at all; the rename is cosmetic. A failure between them leaves
a project that works but is still called "Default project", recoverable by
retrying (the retry re-reads the config, so `expectedVersion` is fresh). The
other order left a project renamed to the visitor's website yet unable to ingest
a single event, which is the state the flow exists to prevent.

## Motion

### Three acts, one integer

The right pane is the same dashboard on all three screens, so the flow reads as
one continuous shot. `ACT` in `onboarding-motion.ts` is the single integer that
drives it, derived by `onboardingAct(stepIndex, isRecording)`:

- **ACT 0 IDENTITY** — the project takes your site's name. Typing zooms the
  camera in; blurring releases it.
- **ACT 1 PROMISE** — the camera rests wide: the whole dashboard, empty, held
  across install and while waiting, so the left pane carries the step.
- **ACT 2 LIVE** — the first event lands. The frame lifts 10px and its shadow
  deepens. That lift is the entire payoff, and it is deliberately all that
  happens: no session has finalised yet, so any number the preview showed here
  would be a lie, and the product ships no "recording" affordance on Overview to
  borrow. Reaching this act outranks the step, so stepping Back does not take
  the payoff away.

The steps are separate routes and cannot see each other, so the verify step
reports the first event up into the shell rather than animating the preview
itself. Naming stays a transient override rather than a rung on the ladder, so
someone who steps Back to change their website after connecting still gets the
zoom.

The storyboard in `onboarding-motion.ts` is the authority. Vocabulary is
transitions.dev's, expressed with this codebase's bounce-free springs and
framer-motion rather than its CSS variables:

- step change — "page side-by-side": 8px travel along the direction of travel,
  3px cross-blur. Back travels the other way.
- within a step — "texts reveal": 12px rise with a cross-blur, staggered in
  reading order, tightened from the reference so the primary action is legible
  by the time the pointer arrives.
- form frame — "card resize": the shell's persistent frame owns the height
  tween, because a routed step cannot keep a ghost copy mounted to cross-fade
  against.
- copy control — the shared `IconSwap`.
- first event — a stroke-drawn check clearing an 8px blur.
- invalid URL — a decaying shake, keyframed in CSS; amplitude decays and no
  segment overshoots.

Reduced motion collapses every one of these: each component passes
`initial={false}` and a zero-duration transition, and the three CSS keyframe
sequences are disabled in a `prefers-reduced-motion` block.

## The preview

The right pane renders the **real `AppShell`** — the same header, project
switcher, environment badge, tab row and workspace card the dashboard ships —
inside a fixed 1100×1080 stage that a camera scales and translates. It is
`inert` and `aria-hidden`, so none of its links or controls are reachable. Two
optional `AppShell` props exist only for it: `projectLabel`, so the switcher
follows the field before the rename is saved, and `rootClassName`, so the shell
can be framed by the stage instead of the viewport.

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

### Deliberate deviation from the lab

The lab drew a generated one-letter favicon beside the project name and the
approved reference lists it as a must-match. The shipped dashboard's project
switcher has no favicon, and this preview is the real switcher, so the favicon
is not there. Adding one would mean changing the switcher everywhere in the
product. Flagged rather than silently dropped.

## Verification

`vp check` reports zero errors (four pre-existing rrweb warnings remain) and
all tests pass. `apps/dashboard/tests/onboarding-activation.test.tsx` covers
the URL helpers, the origin allowlist including the port case, the step model,
the routing decision, all three steps' behavior, and the key-minting rules.
The worker route is covered end-to-end in
`apps/worker/tests/api-recordings-projects.test.ts`, and its access matrix
entry in `apps/worker/tests/dashboard-request-policy.test.ts`.

Visual proof came from real Chrome against the existing dev server on 8787 with
`/api/v1/*` stubbed client-side; nothing was written to the local worker. Note
for future passes: that tab is hidden, so `requestAnimationFrame` is suspended
and framer-motion holds every element at its `initial` value — force the
settled state before judging, and judge end states only. The dev server's SPA
fallback answers every path, so it cannot prove the reachability lists above;
`dashboard-spa-routes.test.mjs` is what covers those.

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
