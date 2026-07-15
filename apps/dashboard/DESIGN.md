---
name: Orange Replay Dashboard
description: A calm evidence workspace for finding and understanding real session friction.
colors:
  background: "oklch(0.146 0.004 285.857)"
  panel: "oklch(0.179 0.006 285.767)"
  raised-surface: "oklch(0.202 0.008 285.67)"
  foreground: "oklch(0.945 0.007 286.271)"
  muted-text: "oklch(0.64 0.015 285.975)"
  dim-label: "oklch(0.5 0.016 285.816)"
  border: "oklch(0.259 0.011 285.594)"
  diagnostic-amber: "oklch(0.784 0.159 72.991)"
  calm-teal: "oklch(0.785 0.133 181.912)"
  danger: "oklch(0.662 0.198 25.892)"
  success: "oklch(0.773 0.153 163.223)"
  player-blue: "oklch(0.693 0.165 253.956)"
typography:
  page-title:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: normal
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: normal
    letterSpacing: normal
  label:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: normal
    letterSpacing: "0.06em"
  data:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: normal
    letterSpacing: normal
  metric:
    fontFamily: "Departure Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "21px"
    fontWeight: 400
    lineHeight: normal
    letterSpacing: normal
rounded:
  sm: "4px"
  md: "6px"
  field: "7px"
  lg: "8px"
  xl: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  shell: "28px"
components:
  button-primary:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 13px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 13px"
    height: "32px"
  input:
    backgroundColor: "{colors.raised-surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.data}"
    rounded: "{rounded.field}"
    padding: "7px 12px"
    height: "32px"
  status-pill:
    backgroundColor: "{colors.raised-surface}"
    textColor: "{colors.muted-text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "20px"
  top-level-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
---

# Design System: Orange Replay Dashboard

## Overview

**Creative North Star: "The Evidence Room"**

Orange Replay is a calm, precise room for examining what happened in a real session. The near-black shell lowers visual noise; evidence, diagnostics, and playback controls carry the contrast. The interface is technical without becoming cold or theatrical, and dense without becoming cramped.

The system feels restrained and component-led. Familiar controls, consistent geometry, quiet dashed structure, and a small signal palette let users move quickly from a session list to the exact click, error, or friction point. Generic analytics-dashboard decoration, oversized cards, heavy gradients, weak gray-on-gray contrast, and fake affordances are explicitly rejected.

**Key Characteristics:**

- Dark-only evidence workspace with quiet chrome.
- Dense, readable data aligned on a dependable spacing rhythm.
- Diagnostic Amber reserved for action, focus, friction, and playback position.
- Mono, tabular numerals for every measurable value.
- Familiar components with complete hover, focus, active, disabled, loading, and error states.

## Colors

The palette is a restrained violet-black neutral system with three clear signal roles: Diagnostic Amber for attention, Calm Teal for live or positive evidence, and red for failure.

### Primary

- **Diagnostic Amber** (`diagnostic-amber`): marks the active tab, focus ring, warning counts, rage evidence, playback position, and the few moments that need immediate attention. It is never a large decorative fill.

### Secondary

- **Calm Teal** (`calm-teal`): marks live presence, navigation evidence, low-friction heat, and calm positive data. It supports Amber; it does not compete with it.

### Tertiary

- **Failure Red** (`danger`): errors, destructive outcomes, and rage intensity where failure is the meaning.
- **Healthy Green** (`success`): successful or currently live state when the distinction must be explicit.
- **Playback Blue** (`player-blue`): click evidence in replay timelines and nowhere else.

### Neutral

- **Evidence Canvas** (`background`): the dark-only application canvas.
- **Panel Black** (`panel`): top-level cards and persistent panels.
- **Raised Graphite** (`raised-surface`): inputs, popovers, chips, and nested controls.
- **Primary Ink** (`foreground`): headings, strong labels, and the light-filled primary button.
- **Muted Copy** (`muted-text`): the minimum contrast for sentence-level secondary text.
- **Dim Label** (`dim-label`): table headers, compact labels, and decorative icons only.
- **Quiet Border** (`border`): solid hairlines and control boundaries.

**The One Signal Rule.** Diagnostic Amber is the primary attention color. Use it for active state, focus, friction, and playback position; never spend it as decoration.

**The Shape Plus Color Rule.** Status must always combine color with text, an icon, a dot, or geometry. Color alone never carries meaning.

## Typography

**Display Font:** Inter Variable with Inter and system sans fallbacks\
**Body Font:** Inter Variable with Inter and system sans fallbacks\
**Label/Code Font:** Uncut Plan8 with SF Mono and Menlo fallbacks\
**Numeric Font:** Departure Mono with SF Mono and Menlo fallbacks

**Character:** Inter keeps navigation and controls familiar, neutral, and fast to scan. Uncut Plan8 keeps code, URLs, and identifiers distinct. Departure Mono gives measurable values a precise pixel-grid character without turning the whole product into a terminal.

### Hierarchy

- **Page title** (600, 18px, normal line height): one compact heading per screen with slightly tightened spacing.
- **Metric** (400, 21px, normal line height): high-value counts and durations; use Amber only when the nonzero value is a warning.
- **Body** (400, 13px, normal line height): default interface copy, table data, and control labels. Long prose is capped at 65–75 characters.
- **Data** (400, 12px, normal line height): durations, identifiers, timestamps, byte counts, and other tabular values.
- **Label** (500, 11px, 0.06em tracking): short table headers and micro-labels only; uppercase is allowed only when it improves scanning.

**The Measured Number Rule.** Every data numeral uses Departure Mono and tabular figures. A digits-only fallback also covers numbers inside otherwise sans text without changing the surrounding words. Numeric table columns are right-aligned. Do not synthesize heavier weights; the regular cut keeps its pixel geometry intact.

**The Quiet Hierarchy Rule.** Product hierarchy comes from weight, alignment, and spacing. Do not introduce display type or oversized headings into the dashboard.

## Elevation

The system uses structural layers. Tonal nesting and borders establish most hierarchy; measured shadow is reserved for top-level `.lit` panels and floating surfaces. The signature panel adds fine grain, a quiet dashed edge, and a permanent top-left bloom. Nested surfaces stay flat and use Raised Graphite with a normal border.

### Shadow Vocabulary

- **Top-level panel lift** (`0 14px 34px oklch(0 0 0 / 0.42)`): only for `.lit` cards and panels that organize a screen.
- **Low control lift** (`shadow-surface-2`): subtle one-pixel definition for ordinary controls.
- **Floating surface lift** (`shadow-surface-5`): menus, popovers, and other content that must sit clearly above the task.
- **Signal glow** (Amber or red at 70% alpha): playheads, error markers, and momentary diagnostic emphasis only.

**The Structural Layers Rule.** Borders and tonal nesting explain the layout first. Shadow confirms real elevation; it never decorates a flat element.

**The One Lit Layer Rule.** Apply `.lit` only to top-level panels. Never nest `.lit`; nested boxes use a solid border and Raised Graphite.

## Components

Components are precise, familiar, and restrained. Existing Fluid Functionalism registry components remain the source of truth; new screens compose them instead of inventing a second vocabulary.

### Buttons

- **Shape:** gently rounded rectangle (8px) with fixed 32px or 36px height.
- **Primary:** light foreground fill, dark text, 12.5–13px semibold label, and no Amber fill.
- **Hover / Focus:** quiet fill shift on hover, 4% press compression, and a one-pixel Diagnostic Amber focus ring.
- **Secondary:** Panel Black fill with a Quiet Border; hover moves to the next tonal surface.
- **Ghost:** transparent and muted at rest, becoming Primary Ink on hover.
- **States:** disabled reduces opacity and removes pointer input; loading preserves the label width and centers an inline progress glyph.

### Chips

- **Style:** compact 20px pills with 11px medium labels. Error and rage chips use a tinted background, tinted border, readable text, and a six-pixel status dot.
- **State:** render a status pill only when there is something to say. Healthy rows stay quiet; absence is the signal.

### Cards / Containers

- **Corner Style:** 8px for top-level panels and ordinary nested boxes.
- **Background:** Panel Black for top-level panels; Raised Graphite for nested controls and inset surfaces.
- **Shadow Strategy:** `.lit` receives top-level panel lift; nested surfaces remain flat.
- **Border:** signature panels use the dashed bloom edge; nested surfaces use one solid Quiet Border.
- **Internal Padding:** 16–20px for panels, reduced only for dense tables and rails.

### Inputs / Fields

- **Style:** Raised Graphite fill, Quiet Border, 7px radius, 12px type, and 7px by 12px internal padding.
- **Focus:** one-pixel Diagnostic Amber ring; icons strengthen from 1.5px to 2px stroke.
- **Error / Disabled:** errors use red border, label, and message together; disabled fields reduce opacity and stop pointer input.

### Navigation

- **Style:** a two-tier top navigation on translucent dark chrome. The first tier carries brand, project, environment, and account actions; the second carries real routes only.
- **State:** inactive tabs use Muted Copy, hover moves to Primary Ink, and the active tab gets a two-pixel Diagnostic Amber underline with medium weight.
- **Responsive behavior:** preserve the task and its active route; shorten or scroll secondary controls before collapsing core navigation meaning.

### Tables and Session Rails

- **Headers:** 11px uppercase labels with 0.06em tracking and Dim Label color.
- **Rows:** 12px by 16px cell padding, quiet separators, tonal hover, visible inset focus, and a clear navigation affordance.
- **Numbers:** mono and tabular; important values use Primary Ink while secondary values use Muted Copy.

### Replay Evidence

- **Timeline:** a quiet baseline with compact activity ticks, red error markers, and one glowing Diagnostic Amber playhead.
- **Event language:** click is Playback Blue, rage is Diagnostic Amber, error is Failure Red, and navigation is Calm Teal. These mappings never change between list, timeline, and detail views.
- **Motion:** 80–250ms state transitions only. Playback feedback may glow briefly; reduced-motion users receive an instant or crossfade alternative.

## Do's and Don'ts

### Do:

- Do let session evidence, counts, and playback state carry the visual emphasis.
- Do use the existing Fluid Functionalism registry component when it provides the required control.
- Do keep sentence-level secondary text at Muted Copy contrast or stronger; Dim Label is for tertiary labels only.
- Do make every action keyboard reachable with a deliberate visible focus state.
- Do keep dense rows readable through alignment, 12px by 16px cell padding, and mono tabular numerals.
- Do pair status color with text, shape, a dot, or an icon.
- Do respect reduced motion and keep product motion tied to state or feedback.

### Don't:

- Don't turn the interface into a generic analytics dashboard.
- Don't use oversized decorative cards or nest `.lit` panels.
- Don't use heavy gradients or Amber-filled primary buttons.
- Don't ship weak gray-on-gray contrast or use Dim Label for sentence-level copy.
- Don't cram data rows until labels, targets, or values lose breathing room.
- Don't rely on browser-default focus treatments.
- Don't render controls that look interactive without working.
- Don't invent a new icon family, status mapping, button shape, or form-control vocabulary for one screen.
- Don't add decorative page-load choreography; the dashboard opens directly into the task.
