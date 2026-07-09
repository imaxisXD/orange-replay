<!-- october:canvas-guide:start -->

# Working in this app (built with October)

This project is built inside **October**, a spatial canvas where each app **screen/route shows up as its own node**. October discovers screens by scanning the route files on disk, so how you structure routes is exactly what the user sees on the canvas.

## One screen = one route file

Give every screen its own route and its own component file, and register each route in the app's router. Use flat, lowercase, hyphenated route paths (e.g. `/sign-up`).

## When the user asks for a flow or multiple screens

Onboarding, a wizard, "a few screens", steps, a set of screens — **create one separate route file per screen.** Never put multiple screens inside a single component: no internal step/pager/carousel state standing in for separate screens, and no extra screen components exported from one file. One screen = one file = one route, so each shows up as its own node on the canvas.

## Dependencies

When you import a new package, add it to `package.json` in the same change (for Expo / React Native, run `npx expo install <pkg>` so it picks a compatible version and writes `package.json` for you). Anything missing from `package.json` disappears on a clean install and crashes the app.

<!-- october:canvas-guide:end -->
