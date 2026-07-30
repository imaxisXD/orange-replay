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

Only the page body is stand-in content: the Overview page's real metric labels
with pending values, so the preview promises exactly what the dashboard
delivers once the first session lands.

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

### Timing: a push and a pull-out are not the same move

`CAMERA.spring` (520ms) pushes in and `CAMERA.releaseSpring` (760ms) releases.
Film convention gives a reveal more time than the push that preceded it, and
with equal timings blurring the field read as the camera snapping back.

Act 2 staggers rather than firing together: the check strokes in on the left,
and `PREVIEW_FRAME.liveDelay` (180ms) holds the frame's lift back so the eye is
led left to right. Two moves running at once in two places give it nothing to
follow. The CSS shadow transition carries the same 180ms delay so the shadow
travels with the lift instead of ahead of it.

### The camera: a shallow zoom about the frame's corner

Both stops sit flush at the frame's top-left, so that corner is the fixed point
and the zoom is a plain scale about it: `0.78 → 1.01`, no translate. The brand,
the nav, the page heading and the metric band all hold position and simply get
closer. Nothing is cropped and nothing slides.

Two earlier attempts added a translate, and both were wrong in different ways.
`y: 120` pushed the header into mid-frame behind a band of empty canvas, so the
nav read as re-laying itself out rather than as a camera moving. Cancelling the
subject's drift with `x: -169` held the switcher's column exactly, but at
`1.42` it cropped the brand and the dashboard stopped reading as a dashboard —
it became a wall of chrome.

The scale comes from measuring a reference framing two ways off its own
geometry, so the retina factor cancels: the KPI band's height and its
four-column pitch both put it at `2.02x` the unscaled stage in a 2x capture,
i.e. `1.01` CSS.

The camera tests assert the invariants rather than the literal numbers: the
corner is fixed at both stops, neither stop has a negative offset (which would
crop the brand or the header), the focus scale stays under `1.1`, and the
subject's drift stays well under the 169px swing that read as a slide.

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
