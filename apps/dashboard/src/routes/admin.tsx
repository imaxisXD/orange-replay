import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { LoadingArea, LoadingIndicator } from "@/components/ui/loading-indicator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  accountQueryKey,
  fetchAccount,
  fetchAdminStats,
  fetchAdminUsers,
  type AdminUser,
} from "@/lib/api";
import { adminAuthClient } from "@/lib/admin-auth-client";
import { readAuthClientError, signOutHosted } from "@/lib/auth-client";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import {
  AlertCircle,
  ArrowLeft,
  Building,
  KeyRound,
  LogOut,
  RotateCcw,
  Search,
  ShieldUser,
  UserBlock,
  Users,
} from "@/lib/icon-map";
import { queryClient } from "@/lib/query";

const pageSize = 25;

type AdminAction =
  | { type: "set-role"; userId: string; role: "admin" | "user" }
  | { type: "ban"; userId: string }
  | { type: "unban"; userId: string }
  | { type: "revoke-sessions"; userId: string };

export function AdminPage() {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [actionToConfirm, setActionToConfirm] = useState<AdminAction | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    staleTime: 30_000,
  });
  const statsQuery = useQuery({ queryKey: ["admin-stats"], queryFn: fetchAdminStats });
  const usersQuery = useQuery({
    queryKey: ["admin-users", pageSize, offset, search],
    queryFn: () => fetchAdminUsers({ limit: pageSize, offset, search }),
  });
  const actionMutation = useMutation({
    mutationFn: runAdminAction,
    onSuccess: async () => {
      setActionToConfirm(null);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["admin-users"] }),
        cache.invalidateQueries({ queryKey: ["admin-stats"] }),
        cache.invalidateQueries({ queryKey: accountQueryKey }),
      ]);
    },
  });
  const users = usersQuery.data?.users ?? [];
  const total = usersQuery.data?.total ?? 0;
  const firstShown = total === 0 ? 0 : offset + 1;
  const lastShown = Math.min(offset + pageSize, total);
  const actionError = readAuthClientError(actionMutation.error, "The account change failed.");
  const confirmationUser = users.find((user) => user.id === actionToConfirm?.userId);

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
  }

  async function signOut(): Promise<void> {
    setIsSigningOut(true);
    setSignOutError("");
    try {
      await signOutHosted(adminAuthClient);
      queryClient.clear();
      void navigate({ to: "/login", replace: true });
    } catch (error) {
      setSignOutError(readAuthClientError(error, "Could not sign out. Try again."));
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-chrome px-4 py-3 backdrop-blur sm:px-7">
        <div className="mx-auto flex max-w-350 items-center gap-3">
          <BrandMark />
          <span className="text-[14px] font-semibold">Orange Replay</span>
          <span className="text-divider">/</span>
          <Badge color="amber" size="sm">
            Operator
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild leadingIcon={ArrowLeft} size="sm" variant="ghost">
              <Link to="/projects">Dashboard</Link>
            </Button>
            {signOutError.length > 0 && (
              <p className="max-w-48 text-right text-[11.5px] text-danger" role="alert">
                {signOutError}
              </p>
            )}
            <Button
              leadingIcon={LogOut}
              loading={isSigningOut}
              onClick={() => void signOut()}
              size="sm"
              variant="ghost"
            >
              Log out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-350 flex-col gap-5 px-4 py-6 sm:px-7">
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.015em]">Operator console</h1>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Manage Orange Replay accounts. Every change is checked again by the server.
          </p>
        </div>

        <AdminStats
          error={statsQuery.error}
          loading={statsQuery.isPending}
          onRetry={() => void statsQuery.refetch()}
          stats={statsQuery.data}
        />

        <section className="lit overflow-hidden rounded-lg">
          <div className="flex flex-col gap-3 border-b border-dashed border-dash px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-[15px] font-medium">Users</h2>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Search by name or email, then choose a real account action.
              </p>
            </div>
            <form className="flex items-end gap-2" onSubmit={submitSearch}>
              <InputGroup className="w-full sm:w-68">
                <InputField
                  hideLabel
                  icon={Search}
                  index={0}
                  label="Search users"
                  onChange={setSearchInput}
                  placeholder="Search users"
                  value={searchInput}
                />
              </InputGroup>
              <Button type="submit" variant="secondary">
                Search
              </Button>
            </form>
          </div>

          {actionMutation.isError && actionToConfirm === null && (
            <Alert className="m-5 mb-0" variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Account change failed</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          {usersQuery.isPending ? (
            <LoadingArea className="min-h-84" label="Loading users" />
          ) : usersQuery.isError ? (
            <Empty className="m-5 border border-danger-border py-10">
              <EmptyHeader>
                <EmptyTitle>Could not load users</EmptyTitle>
                <EmptyDescription>Check the Worker and try again.</EmptyDescription>
              </EmptyHeader>
              <Button
                leadingIcon={RotateCcw}
                onClick={() => void usersQuery.refetch()}
                size="sm"
                variant="secondary"
              >
                Retry
              </Button>
            </Empty>
          ) : users.length === 0 ? (
            <Empty className="m-5 border border-dash py-10">
              <EmptyHeader>
                <EmptyTitle>No users found</EmptyTitle>
                <EmptyDescription>Try a shorter name or email search.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x">
              <Table className="min-w-275">
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Workspaces</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead>Last sign-in</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user, index) => (
                    <AdminUserRow
                      busy={actionMutation.isPending && actionMutation.variables.userId === user.id}
                      currentUserId={accountQuery.data?.user.id}
                      index={index}
                      key={user.id}
                      onAction={(action) => {
                        actionMutation.reset();
                        if (action.type === "ban" || action.type === "revoke-sessions") {
                          setActionToConfirm(action);
                        } else {
                          actionMutation.mutate(action);
                        }
                      }}
                      user={user}
                    />
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-dashed border-dash px-5 py-3">
            <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {firstShown}–{lastShown} of {total}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - pageSize))}
                size="sm"
                variant="secondary"
              >
                Previous
              </Button>
              <Button
                disabled={offset + pageSize >= total}
                onClick={() => setOffset((value) => value + pageSize)}
                size="sm"
                variant="secondary"
              >
                Next
              </Button>
            </div>
          </div>
        </section>

        <Dialog
          onOpenChange={(open) => {
            if (!open && !actionMutation.isPending) {
              setActionToConfirm(null);
              actionMutation.reset();
            }
          }}
          open={actionToConfirm !== null}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {actionToConfirm?.type === "ban"
                  ? `Ban ${confirmationUser?.name ?? "this user"}?`
                  : `Revoke all sessions for ${confirmationUser?.name ?? "this user"}?`}
              </DialogTitle>
              <DialogDescription>
                {actionToConfirm?.type === "ban"
                  ? "They will be signed out and unable to sign in until an operator unbans them."
                  : "They will be signed out on every device and will need to sign in again."}
              </DialogDescription>
            </DialogHeader>
            {actionMutation.isError && (
              <p className="mt-4 text-[13px] text-danger" role="alert">
                {actionError}
              </p>
            )}
            <DialogFooter>
              <Button
                disabled={actionMutation.isPending}
                onClick={() => {
                  setActionToConfirm(null);
                  actionMutation.reset();
                }}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                className="border border-danger-border bg-danger-surface text-danger-foreground"
                loading={actionMutation.isPending}
                onClick={() => {
                  if (actionToConfirm !== null) actionMutation.mutate(actionToConfirm);
                }}
              >
                {actionToConfirm?.type === "ban" ? "Ban user" : "Revoke sessions"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}

function AdminStats({
  error,
  loading,
  onRetry,
  stats,
}: {
  error: unknown;
  loading: boolean;
  onRetry: () => void;
  stats?: {
    users: number;
    newUsers: number;
    workspaces: number;
    projects: number;
    activeKeys: number;
  };
}) {
  if (error !== null) {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>Could not load account totals</AlertTitle>
        <AlertDescription>
          <Button
            className="mt-2 border-danger-border bg-transparent text-danger-foreground"
            leadingIcon={RotateCcw}
            onClick={onRetry}
            size="sm"
            variant="secondary"
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (loading) {
    return <LoadingArea className="lit min-h-28 rounded-lg" label="Loading account totals" />;
  }

  const items = [
    { label: "Users", value: stats?.users, icon: Users },
    { label: "New users · 7 days", value: stats?.newUsers, icon: Users },
    { label: "Workspaces", value: stats?.workspaces, icon: Building },
    { label: "Projects", value: stats?.projects, icon: ShieldUser },
    { label: "Active keys", value: stats?.activeKeys, icon: KeyRound },
  ];

  return (
    <section className="lit grid overflow-hidden rounded-lg sm:grid-cols-2 lg:grid-cols-5">
      {items.map((item) => (
        <div
          className="border-b border-dashed border-dash px-4 py-4 last:border-b-0 sm:border-r sm:last:border-r-0 lg:border-b-0"
          key={item.label}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11.5px] text-muted-foreground">{item.label}</p>
            <item.icon aria-hidden className="text-dim" />
          </div>
          <p className="mt-1 font-mono text-[21px] font-semibold tabular-nums tracking-[-0.02em]">
            {(item.value ?? 0).toLocaleString()}
          </p>
        </div>
      ))}
    </section>
  );
}

function AdminUserRow({
  busy,
  currentUserId,
  index,
  onAction,
  user,
}: {
  busy: boolean;
  currentUserId?: string;
  index: number;
  onAction: (action: AdminAction) => void;
  user: AdminUser;
}) {
  const isCurrentUser = currentUserId === user.id;
  const role = user.role === "admin" ? "admin" : "user";

  return (
    <TableRow index={index}>
      <TableCell>
        <div className="flex min-w-48 items-center gap-2.5">
          <AdminAvatar image={user.image} name={user.name} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-foreground">
              {user.name} {isCurrentUser ? <span className="text-dim">(you)</span> : null}
            </p>
            <p className="truncate text-[11.5px] text-muted-foreground">{user.email}</p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Select
          disabled={busy || isCurrentUser}
          onValueChange={(nextRole) =>
            onAction({
              type: "set-role",
              userId: user.id,
              role: nextRole === "admin" ? "admin" : "user",
            })
          }
          value={role}
        >
          <SelectTrigger
            aria-label={`Role for ${user.name}`}
            className="h-8 min-w-24 rounded-[7px] border-border bg-secondary text-[12px]"
          />
          <SelectContent className="rounded-lg border border-border bg-popover">
            <SelectGroup>
              <SelectItem index={0} value="user">
                User
              </SelectItem>
              <SelectItem index={1} value="admin">
                Admin
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Badge color={user.banned ? "red" : "green"} size="sm" variant="dot">
          {user.banned ? "Banned" : "Active"}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-[12px] tabular-nums">{user.workspaceCount}</TableCell>
      <TableCell className="text-[12px]" title={formatAbsoluteTime(user.createdAt)}>
        {formatRelativeTime(user.createdAt)}
      </TableCell>
      <TableCell
        className="text-[12px]"
        title={user.lastSignedInAt === null ? undefined : formatAbsoluteTime(user.lastSignedInAt)}
      >
        {user.lastSignedInAt === null ? "Never" : formatRelativeTime(user.lastSignedInAt)}
      </TableCell>
      <TableCell>
        {busy ? (
          <div className="flex min-h-8 items-center justify-end pr-3">
            <LoadingIndicator label={`Updating ${user.name}`} />
          </div>
        ) : (
          <div className="flex justify-end gap-1">
            <Button
              className={user.banned ? undefined : "text-danger-foreground hover:text-foreground"}
              disabled={isCurrentUser}
              leadingIcon={UserBlock}
              onClick={() => onAction({ type: user.banned ? "unban" : "ban", userId: user.id })}
              size="sm"
              variant="ghost"
            >
              {user.banned ? "Unban" : "Ban"}
            </Button>
            <Button
              disabled={isCurrentUser}
              onClick={() => onAction({ type: "revoke-sessions", userId: user.id })}
              size="sm"
              variant="ghost"
            >
              Revoke sessions
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function AdminAvatar({ image, name }: { image: string | null; name: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  if (image !== null && image.length > 0 && !imageFailed) {
    return (
      <img
        alt=""
        className="size-7 shrink-0 rounded-full border border-border bg-secondary object-cover"
        onError={() => setImageFailed(true)}
        referrerPolicy="no-referrer"
        src={image}
      />
    );
  }

  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-[10px] font-semibold text-muted-foreground"
    >
      {initials || "U"}
    </span>
  );
}

async function runAdminAction(action: AdminAction): Promise<void> {
  let result;
  switch (action.type) {
    case "set-role":
      result = await adminAuthClient.admin.setRole({ userId: action.userId, role: action.role });
      break;
    case "ban":
      result = await adminAuthClient.admin.banUser({
        userId: action.userId,
        banReason: "Banned by an Orange Replay operator.",
      });
      break;
    case "unban":
      result = await adminAuthClient.admin.unbanUser({ userId: action.userId });
      break;
    case "revoke-sessions":
      result = await adminAuthClient.admin.revokeUserSessions({ userId: action.userId });
      break;
  }

  if (result.error !== null && result.error !== undefined) {
    throw result.error;
  }
}
