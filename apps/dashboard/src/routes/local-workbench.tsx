import { lazy, Suspense, type ComponentType } from "react";
import { useParams } from "@tanstack/react-router";

type LocalLabModule = Record<string, unknown> & {
  default?: ComponentType;
};

interface LocalLab {
  Component: ReturnType<typeof lazy>;
  id: string;
  label: string;
}

const localLabLoaders = import.meta.env.DEV ? import.meta.glob<LocalLabModule>("./*-lab.tsx") : {};
const localLabs = Object.entries(localLabLoaders)
  .map(([path, loadModule]): LocalLab => {
    const id = path.slice(2, -"-lab.tsx".length);
    return {
      Component: lazy(async () => ({ default: findLabComponent(await loadModule(), path) })),
      id,
      label: id
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
    };
  })
  .sort((left, right) => left.label.localeCompare(right.label));

export function LocalLabsIndexPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber">Local only</p>
        <h1 className="mt-2 text-2xl font-semibold">Dashboard labs</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          These experiments live only on this machine. Add a file ending in
          <code className="mx-1 rounded bg-surface-2 px-1.5 py-0.5">-lab.tsx</code>
          to the routes folder and it will appear here automatically.
        </p>

        {localLabs.length === 0 ? (
          <p className="mt-8 rounded-lg border border-dashed border-dash p-5 text-sm text-muted-foreground">
            No local labs found.
          </p>
        ) : (
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {localLabs.map((lab) => (
              <li key={lab.id}>
                <a
                  className="lit block rounded-lg p-4 text-sm font-medium transition-colors hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                  href={`/local-labs/${lab.id}`}
                >
                  {lab.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

export function LocalLabPage() {
  const { labId } = useParams({ strict: false }) as { labId?: string };
  const lab = localLabs.find((candidate) => candidate.id === labId);

  if (!lab) {
    return (
      <main className="min-h-screen bg-background px-6 py-10 text-foreground">
        <div className="mx-auto max-w-3xl">
          <a className="text-sm text-amber hover:underline" href="/local-labs">
            Back to local labs
          </a>
          <h1 className="mt-6 text-2xl font-semibold">Lab not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This lab file may have been renamed or removed from this machine.
          </p>
        </div>
      </main>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
          Loading {lab.label}…
        </div>
      }
    >
      <lab.Component />
    </Suspense>
  );
}

function findLabComponent(labModule: LocalLabModule, path: string): ComponentType {
  if (typeof labModule.default === "function") {
    return labModule.default;
  }

  const namedComponent = Object.entries(labModule).find(
    ([exportName, value]) => exportName.endsWith("LabPage") && typeof value === "function",
  )?.[1];

  if (typeof namedComponent !== "function") {
    throw new Error(
      `${path} must export a React component as default or with a name ending in LabPage.`,
    );
  }

  return namedComponent as ComponentType;
}
