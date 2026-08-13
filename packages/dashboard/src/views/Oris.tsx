import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Clock, Copy, GitFork, Loader2, Monitor, MoreHorizontal, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, type Ori } from "@/lib/api";
import {
  ORI_STATES, RUNNABLE, STOPPABLE, TTL_OPTIONS, TYPES, fetchAllOris, fmtTime, metricTitle,
  orisRunning, stateVariant, stopsIn, type MetricSample, type OriState,
} from "@/lib/oris";
import { cn } from "@/lib/utils";
import { Sparkline } from "@/components/Sparkline";

/** A row mutation: label it, run it, and let the caller say which row it belongs to. */
type Act = (
  label: string,
  fn: () => Promise<unknown>,
  opts?: { id?: string; optimisticState?: OriState },
) => Promise<void>;

export function OrisView() {
  const [oris, setOris] = useState<Ori[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [snapFilter, setSnapFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState<Ori | null>(null);
  const [deleting, setDeleting] = useState<Ori | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, MetricSample[]>>({});

  /*
   * Ori ids with a mutation in flight, mapped to what it is doing. Two jobs: the row says so,
   * and a second click cannot fire the same mutation twice while the first is still open.
   * The ref shadows the state because the guard has to read the current value synchronously
   * inside the click handler, before React has re-rendered.
   */
  const [pending, setPending] = useState<Record<string, string>>({});
  const pendingRef = useRef<Record<string, string>>({});

  // A ref so the metrics effect can read the current list without re-running on every list poll.
  const orisRef = useRef<Ori[]>([]);
  useEffect(() => { orisRef.current = oris; }, [oris]);

  /*
   * One list fetch at a time.
   *
   * `fetchAllOris` walks the cursor to the end, so a single call is already several requests on a
   * large fleet. Without this guard an interval tick, a visibility change and the refresh at the
   * end of every mutation can all be in flight together, each re-paginating the whole list, and a
   * slow response makes them stack rather than queue.
   */
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setOris(await fetchAllOris());
    } catch {
      /* a failed poll is not worth a toast on every tick */
    } finally {
      inFlight.current = false;
      setLoaded(true);
    }
  }, []);

  /*
   * Poll every 10s, but only while the tab is visible. A dashboard left open all day must not
   * hammer the API from a background tab.
   *
   * 10s rather than something snappier because the row no longer waits for a poll to show what
   * happened: every mutation acks instantly and patches its own row (see `act`). The poll is now
   * only responsible for changes this tab did not cause — a TTL expiring, the reaper stopping
   * something, another client — none of which need second-level latency.
   */
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer ??= setInterval(() => void refresh(), 10_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : (void refresh(), start()));
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  /*
   * Metrics poll at the source cadence and only for sandboxes that are actually running.
   *
   * The reaper records one sample a minute, so this is 60s because that is how often the answer
   * can actually change — at 15s three of every four responses came back byte-identical. This
   * poll is the expensive one: it is a request per running sandbox, where the list is one
   * paginated call for the whole fleet.
   */
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.hidden) return;
      const running = orisRunning(orisRef.current);
      if (running.length === 0) return;
      const pairs = await Promise.all(
        running.map(async (id) => {
          try {
            const r = await apiGet<{ samples?: MetricSample[] }>(`/oris/${id}/metrics`);
            return [id, r.samples ?? []] as const;
          } catch {
            return [id, []] as const;
          }
        }),
      );
      if (!cancelled) setMetrics((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const q = search.trim().toLowerCase();
  const rows = oris.filter((b) => {
    if (stateFilter !== "all" && b.state !== stateFilter) return false;
    const snapOk = !!b.snapshotCompletedAt;
    if (snapFilter === "with" && !snapOk) return false;
    if (snapFilter === "without" && snapOk) return false;
    if (q && ![b.name, b.subdomain ?? "", b.id].some((v) => v.toLowerCase().includes(q))) return false;
    return true;
  });

  /**
   * Every row mutation goes through here, so every one of them acks on the same tick as the click.
   *
   * The toast is raised *before* `fn()` is awaited and then resolved in place by id. Without that
   * the row actions read as broken: the menu closes and nothing visibly happens until the request
   * settles, which for resume and fork is a server-side restic restore measured in minutes.
   * `optimisticState` moves the badge immediately rather than waiting a poll interval for the
   * same news; the `refresh()` in `finally` is what makes a wrong guess self-correcting.
   */
  const act: Act = useCallback(
    async (label, fn, opts = {}) => {
      const { id, optimisticState } = opts;
      if (id && pendingRef.current[id]) return;
      if (id) {
        pendingRef.current = { ...pendingRef.current, [id]: label };
        setPending(pendingRef.current);
        if (optimisticState) {
          setOris((prev) => prev.map((o) => (o.id === id ? { ...o, state: optimisticState } : o)));
        }
      }
      const t = toast.loading(`${label}…`);
      try {
        await fn();
        toast.success(label, { id: t });
      } catch (e) {
        // A timeout is not a failure: the server is still working and the poll will show the
        // outcome. Reporting "failed" here would be a lie the user then acts on.
        if (e instanceof ApiError && e.code === "timeout") {
          toast.info(`${label} is still running — the list updates when it finishes`, { id: t });
        } else {
          toast.error(e instanceof Error ? e.message : `${label} failed`, { id: t });
        }
      } finally {
        if (id) {
          const { [id]: _done, ...rest } = pendingRef.current;
          pendingRef.current = rest;
          setPending(rest);
        }
        void refresh();
      }
    },
    [refresh],
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Oris</CardTitle>
          <CardAction>
            <Button onClick={() => setCreating(true)}>
              <Plus /> New
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Input
              type="search"
              placeholder="Search name, subdomain, id"
              aria-label="Search oris"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs flex-1"
            />
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger aria-label="Filter by state" className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                {ORI_STATES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={snapFilter} onValueChange={setSnapFilter}>
              <SelectTrigger aria-label="Filter by snapshot" className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All snapshots</SelectItem>
                <SelectItem value="with">Has snapshot</SelectItem>
                <SelectItem value="without">No snapshot</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Ori ID</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Stops in</TableHead>
                  <TableHead>Snapshot</TableHead>
                  <TableHead>CPU/RAM/IO</TableHead>
                  <TableHead className="w-11" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {!loaded ? (
                  <TableRow><TableCell colSpan={7} className="text-muted-foreground py-10 text-center">Loading…</TableCell></TableRow>
                ) : oris.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-muted-foreground py-10 text-center">No oris yet. Click <b>New</b> to create one.</TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-muted-foreground py-10 text-center">No oris match your filters.</TableCell></TableRow>
                ) : (
                  rows.map((b) => (
                    <OriRow
                      key={b.id}
                      ori={b}
                      renaming={renaming === b.id}
                      onRename={() => setRenaming(b.id)}
                      onRenameDone={() => setRenaming(null)}
                      onRefresh={refresh}
                      onStop={() => setStopping(b)}
                      onDelete={() => setDeleting(b)}
                      samples={metrics[b.id] ?? []}
                      act={act}
                      pending={pending[b.id]}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <NewOriDialog open={creating} onOpenChange={setCreating} onCreated={refresh} />
      <StopDialog ori={stopping} onOpenChange={(o) => !o && setStopping(null)} act={act} />
      <DeleteDialog ori={deleting} onOpenChange={(o) => !o && setDeleting(null)} act={act} />
    </>
  );
}

function OriRow({
  ori, renaming, onRename, onRenameDone, onRefresh, onStop, onDelete, samples, act, pending,
}: {
  ori: Ori;
  renaming: boolean;
  onRename: () => void;
  onRenameDone: () => void;
  onRefresh: () => void;
  onStop: () => void;
  onDelete: () => void;
  samples: MetricSample[];
  act: Act;
  /** What this row is currently doing, if anything. Undefined means idle. */
  pending?: string;
}) {
  const ttl = stopsIn(ori);
  const runnable = RUNNABLE.includes(ori.state);
  const busy = pending !== undefined;

  return (
    <TableRow data-id={ori.id} data-busy={busy || undefined} className={cn(busy && "opacity-70")}>
      <TableCell className="font-medium">
        {renaming ? (
          <RenameInput ori={ori} onDone={() => { onRenameDone(); onRefresh(); }} />
        ) : (
          <div className="flex items-center gap-1.5">
            <a href={`#/ori/${ori.id}`} className="hover:underline">{ori.name}</a>
            <Button variant="ghost" size="icon-sm" aria-label="Rename" title="Rename" onClick={onRename}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        )}
      </TableCell>
      <TableCell><span className="mono text-muted-foreground text-xs">{ori.id}</span></TableCell>
      <TableCell>
        {/*
          The in-flight label replaces the state badge rather than sitting next to it. A row that
          says `archived` *and* `Resuming…` at once is two answers to one question; the badge comes
          back the moment the poll confirms what actually happened.
        */}
        {busy ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
            {pending}…
          </span>
        ) : (
          <Badge variant={stateVariant(ori.state)}>{ori.state}</Badge>
        )}
      </TableCell>
      <TableCell>
        {ttl === null ? (
          <span className="text-muted-foreground">—</span>
        ) : ttl === "never" ? (
          <span className="text-muted-foreground text-xs">never</span>
        ) : (
          <div className="flex items-center gap-1">
            <span className="mono text-muted-foreground text-xs">{ttl}</span>
            <Button
              variant="ghost" size="icon-sm" aria-label="Extend TTL" title="Extend TTL by 1 hour"
              disabled={busy}
              onClick={() => act("TTL extended by 1 hour", () => apiPatch(`/oris/${ori.id}`, { ttlSeconds: 3600 }), { id: ori.id })}
            >
              <Clock className="size-3.5" />
            </Button>
          </div>
        )}
      </TableCell>
      <TableCell>
        {ori.snapshotCompletedAt ? (
          <span className="text-success text-xs">● {fmtTime(ori.snapshotCompletedAt)}</span>
        ) : (
          <span className="text-warning text-xs" title="No snapshot yet — stop the ori to create one">● none</span>
        )}
      </TableCell>
      <TableCell title={metricTitle(samples)}>
        <Sparkline
          series={[
            { label: "CPU %", color: "var(--color-warning)", values: samples.map((s) => s.cpuPercent), max: 100 },
            { label: "RAM %", color: "var(--color-success)", values: samples.map((s) => s.memPercent), max: 100 },
            { label: "disk IO", color: "oklch(0.65 0.15 250)", values: samples.map((s) => s.blockIoBytes) },
          ]}
        />
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Actions"><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/*
              Copy SSH copies the CLI command, not a generated `ssh user@host`. machineIp is null
              for the Docker driver by design (a ori lives at a published loopback port on the
              control-plane host), and the CLI already knows how to find and use it.
            */}
            <DropdownMenuItem
              onClick={async () => {
                const cmd = `ori ssh ${ori.id}`;
                try {
                  await navigator.clipboard.writeText(cmd);
                  toast.success(`Copied: ${cmd}`);
                } catch {
                  toast.info(`Run: ${cmd}`);
                }
              }}
            >
              <Copy /> Copy SSH
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!runnable || busy}
              onClick={() =>
                act("Desktop opening", async () => {
                  const r = await apiPost<{ desktopUrl?: string; provisioning?: boolean }>(`/oris/${ori.id}/desktop`);
                  if (!r.desktopUrl) throw new Error("No desktop URL");
                  if (r.provisioning) toast.info("Desktop still starting; give it a moment");
                  window.open(r.desktopUrl, "_blank", "noopener");
                }, { id: ori.id })
              }
            >
              <Monitor /> Desktop
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {ori.state === "archived" ? (
              /*
                Resume blocks server-side on the full restic restore, so this is the action most
                likely to outlast its request. The optimistic `provisioning` badge and the toast
                are what stand in for it; if the request times out the poll still lands the truth.
              */
              <DropdownMenuItem
                disabled={busy}
                onClick={() => act("Resuming", () => apiPost(`/oris/${ori.id}/resume`), { id: ori.id, optimisticState: "provisioning" })}
              >
                <Play /> Resume
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={!STOPPABLE.includes(ori.state) || busy} onClick={onStop} variant="destructive">
                <Square /> Stop
              </DropdownMenuItem>
            )}
            {/* A fork creates a *new* ori, so there is no state on this row to patch — only the list grows. */}
            <DropdownMenuItem disabled={busy} onClick={() => act("Forking", () => apiPost(`/oris/${ori.id}/fork`), { id: ori.id })}>
              <GitFork /> Fork
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/*
              Only offered for an archived ori, which is exactly what the server allows: delete
              is not a second stop. Disabled elsewhere rather than hidden, so the reason the
              action exists is discoverable before the ori is stopped.
            */}
            <DropdownMenuItem disabled={ori.state !== "archived" || busy} onClick={onDelete} variant="destructive">
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function RenameInput({ ori, onDone }: { ori: Ori; onDone: () => void }) {
  const [value, setValue] = useState(ori.name);
  const done = useRef(false);
  async function finish(save: boolean) {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (save && v && v !== ori.name) {
      try {
        await apiPatch(`/oris/${ori.id}`, { name: v });
        toast.success("Renamed");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Rename failed");
      }
    }
    onDone();
  }
  return (
    <Input
      autoFocus
      value={value}
      aria-label="Ori name"
      className="h-8 max-w-[220px]"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void finish(true);
        if (e.key === "Escape") void finish(false);
      }}
    />
  );
}

function NewOriDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [type, setType] = useState("default");
  const [name, setName] = useState("");
  const [ttl, setTtl] = useState("3600");
  const [noEnv, setNoEnv] = useState(false);
  const [display, setDisplay] = useState(false);
  const [env, setEnv] = useState<Array<{ k: string; v: string }>>([]);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const envObj: Record<string, string> = {};
      for (const { k, v } of env) if (k.trim()) envObj[k.trim()] = v;
      const body: Record<string, unknown> = { type, ttlSeconds: ttl === "never" ? null : Number(ttl), noEnv, display };
      if (Object.keys(envObj).length) body.env = envObj;
      const res = await apiPost<{ ori?: { id: string } }>("/oris", body);
      toast.success(`Creating ${res.ori?.id ?? "ori"}`);
      if (name.trim() && res.ori?.id) await apiPatch(`/oris/${res.ori.id}`, { name: name.trim() });
      onOpenChange(false);
      setName("");
      setEnv([]);
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ori</DialogTitle>
          <DialogDescription>A real Linux machine with SSH, Docker and a desktop.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>Type</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TYPES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setType(t.key)}
                  className={cn(
                    "rounded-md border p-2.5 text-left transition-[border-color,background-color,scale] duration-100 active:scale-[0.96] motion-reduce:active:scale-100",
                    type === t.key ? "border-ring bg-accent/50" : "hover:bg-accent/30",
                  )}
                >
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-muted-foreground text-xs">{t.vcpu} vCPU · {t.ram} GB · {t.disk} GB</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="nb-name">Name</Label>
            <Input id="nb-name" placeholder="Optional name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label>Stop after</Label>
            <Select value={ttl} onValueChange={setTtl}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TTL_OPTIONS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">Time until the ori is automatically archived.</p>
          </div>

          <div className="grid gap-2">
            <Label>Environment variables</Label>
            {env.map((row, i) => (
              <div key={i} className="flex gap-2">
                <Input placeholder="KEY" className="mono" value={row.k} onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))} />
                <Input placeholder="value" className="mono" value={row.v} onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))} />
                <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setEnv(env.filter((_, j) => j !== i))}>×</Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setEnv([...env, { k: "", v: "" }])} className="w-fit">
              <Plus /> Add variable
            </Button>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={noEnv} onCheckedChange={(v) => setNoEnv(v === true)} />
            No env — start the ori with none of my secrets
          </label>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={display} onCheckedChange={(v) => setDisplay(v === true)} />
            Display — allow the VNC desktop (off by default; Desktop fails without it)
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={busy}>{busy ? "Creating…" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete is the only irreversible action in the product: it removes the snapshots, which are
 * the ori. So it asks for the id to be typed rather than settling for a red button — the
 * difference between "stop" (recoverable) and "delete" (not) has to survive a misclick.
 */
function DeleteDialog({ ori, onOpenChange, act }: { ori: Ori | null; onOpenChange: (o: boolean) => void; act: Act }) {
  const [confirm, setConfirm] = useState("");
  useEffect(() => setConfirm(""), [ori?.id]);
  const armed = !!ori && confirm.trim() === ori.id;

  return (
    <Dialog open={!!ori} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {ori?.id}?</DialogTitle>
          <DialogDescription>
            This removes the ori and every snapshot it has in object storage. It cannot be
            resumed or forked afterwards, and the data cannot be recovered.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="del-confirm">Type <span className="mono">{ori?.id}</span> to confirm</Label>
          <Input
            id="del-confirm"
            className="mono"
            autoComplete="off"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={!armed}
            onClick={() => {
              if (!ori) return;
              onOpenChange(false);
              void act(`Deleting ${ori.id}`, () => apiDelete(`/oris/${ori.id}`), { id: ori.id });
            }}
          >
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StopDialog({ ori, onOpenChange, act }: { ori: Ori | null; onOpenChange: (o: boolean) => void; act: Act }) {
  return (
    <Dialog open={!!ori} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop {ori?.id}?</DialogTitle>
          <DialogDescription>
            The ori's disk is snapshotted to object storage and the container destroyed. You can
            resume it later from that snapshot.
          </DialogDescription>
        </DialogHeader>
        {/*
          `force: true` is deliberately not offered. It skips waiting for the final snapshot, which
          is a reasonable escape hatch on the CLI and a data-loss button in a dashboard.
        */}
        <p className="text-muted-foreground text-xs">
          A stop whose snapshot is failing is refused rather than losing your work; it is never
          forced from here.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {/*
            The dialog closes on click instead of holding the modal open until the request
            settles. A stop waits for the final snapshot, so that wait is measured in seconds to
            minutes — long enough that a frozen "Stopping…" button reads as a wedged UI. The row's
            in-flight label and the toast report the outcome, including a refusal.
          */}
          <Button
            variant="destructive"
            onClick={() => {
              if (!ori) return;
              onOpenChange(false);
              void act(`Stopping ${ori.id}`, () => apiPost(`/oris/${ori.id}/stop`, {}), {
                id: ori.id,
                optimisticState: "archiving",
              });
            }}
          >
            Stop ori
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
