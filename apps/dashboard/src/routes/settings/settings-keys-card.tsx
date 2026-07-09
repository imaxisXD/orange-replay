import { useQuery } from "@tanstack/react-query";
import type { ProjectKeyAudit } from "@orange-replay/shared/types";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchProjectKeys } from "@/lib/api";
import { Elevated } from "@/lib/elevated";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import { useShape } from "@/lib/shape-context";
import { cn } from "@/lib/utils";
import { CardHeader } from "./settings-fields";

export function KeysCard({ projectId }: { projectId: string }) {
  const shape = useShape();
  const keysQuery = useQuery({
    queryKey: ["project-keys", projectId],
    queryFn: () => fetchProjectKeys(projectId),
  });
  const keys = (keysQuery.data?.keys ?? []).toSorted(
    (left: ProjectKeyAudit, right: ProjectKeyAudit) => right.created_at - left.created_at,
  );
  const loading = keysQuery.isPending;
  const error = keysQuery.error instanceof Error ? keysQuery.error.message : "";

  return (
    <section className="lit overflow-hidden rounded-lg p-5">
      <CardHeader
        title="Write keys"
        body="Keys authenticate the SDK's ingest requests. Values are shown only where you created them."
      />
      <div className="mt-4">
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_item, index) => (
              <Skeleton className="h-10 w-full rounded-[7px]" key={index} />
            ))}
          </div>
        ) : error.length > 0 ? (
          <div className="rounded-lg border border-dashed border-danger-border px-4 py-6 text-[13px] text-danger-foreground">
            {error}
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-lg border border-dashed border-dash px-4 py-8 text-center text-[13px] text-muted-foreground">
            No write keys found.
          </div>
        ) : (
          <div className="-mx-5 -mb-5 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key, index) => (
                  <TableRow index={index} key={key.key_hash}>
                    <TableCell className="font-mono text-[12px] text-foreground">
                      {key.key_hash.slice(0, 12)}…
                    </TableCell>
                    <TableCell>
                      <Elevated
                        className={cn("inline-flex", shape.item)}
                        offset={4}
                        shadowLevel={4}
                      >
                        <Badge color={key.active ? "green" : "gray"} size="sm" variant="dot">
                          {key.active ? "active" : "revoked"}
                        </Badge>
                      </Elevated>
                    </TableCell>
                    <TableCell
                      className="text-[12px] text-dim"
                      title={formatAbsoluteTime(key.created_at)}
                    >
                      {formatRelativeTime(key.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}
