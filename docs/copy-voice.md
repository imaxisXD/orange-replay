# Copy voice

Rules for every user-facing string in Orange Replay — dashboard chrome, empty
states, errors, banners, install instructions, and the marketing↔product
bridges (demo banner, upgrade prompts). Born from the demo-banner rewrite
(2026-07-11) and field research into PostHog, Plausible, Fathom, Linear,
Stripe, and Highlight.

The reference line, and why it works:

> Our own landing page, recorded with our own product. Look closely — you
> might spot yourself.

Beat one is proof (real data, our own site — a claim no adjective can fake).
Beat two addresses the reader and gives them something to do. No disclaimer
anywhere; the hedge ("might") exists only because it's literally true.

## Principles

1. **Say what the thing is, verb-first.** Product chrome is calm and literal.
   "Watch the session", "Try again", "Go to install". Save cleverness for
   marketing surfaces; in-app, the wit is that there is no fluff.
2. **Proof over claims.** Show the receipt instead of the adjective: real
   data, real numbers, named sources ("our own landing page", "5 of 597
   sessions"). If a sentence would survive on a competitor's site unchanged,
   it's a claim, not proof — rewrite it.
3. **Specificity is the personality.** Concrete nouns and numbers beat
   intensifiers. "Sessions finalize about a minute after the tab closes"
   beats "Sessions appear shortly."
4. **No disclaimers.** Never "read-only", "sample data", "for demo purposes
   only". Either state the mechanics as plain fact (Linear: "Changes reset on
   refresh") or let disabled controls teach it. A disclaimer spends our one
   line of attention on legal comfort.
5. **Second person, present tense.** Talk to the reader about their
   situation, not about the product's features. Hedge ("might", "usually")
   only when accuracy demands it — then the hedge builds trust.
6. **The wink lives in the aside.** Main clause informative; personality in
   the parenthetical or the second beat, one per surface at most. PostHog's
   footnote pattern, not pun-led headlines.
7. **Errors own the failure and hand over the exit.** Name what happened,
   then the next action: "Sometimes this happens. Try refreshing, or narrow
   the date range." Never blame the user, never bare "Something went wrong."
8. **Empty states teach.** An empty list is onboarding: say what will fill
   it, and how to cause that. "No sessions yet — install the snippet and
   this fills up on its own" beats "Nothing here."

## Dashboard metrics

Keep the real measurement, but explain it in the language of the person using
the dashboard. A metric label names what happened. Its supporting line explains
how to understand the number, not how the code calculated it.

- Say "Half of sessions lasted 13 seconds or less," not "P50 0:13."
- Say "Based on 37 of 50 sessions," not "37 sessions covered."
- Say "Returned to the previous page within 10 seconds," not
  "A → B → A under 10s."
- Say "Estimated time spent clicking, typing, or scrolling," not
  "Average capped event gaps."
- Keep statistical terms such as P50, percentile, denominator, and warehouse
  version out of the default dashboard. They belong in technical details when
  a user asks how a number was calculated.
- Do not hide uncertainty. Use "estimated," "based on," or an exact session
  count when the measurement is partial or derived.

## CTA vocabulary

Literal actions, sentence case, no marketing verbs:

| Use                 | Not                        |
| ------------------- | -------------------------- |
| Start free          | Unlock / Get started today |
| Watch the session   | View details               |
| Try again           | Retry operation            |
| Install the snippet | Complete setup             |
| Talk to us          | Contact sales              |

## Mechanics

- Sentence case everywhere, including headings and buttons.
- Mono/uppercase is reserved for system labels (status pills, timestamps),
  never for persuasion.
- Numbers are always real and tabular; never round for drama.
- Em dash for the pivot beat ("— you might spot yourself"); one per string.
