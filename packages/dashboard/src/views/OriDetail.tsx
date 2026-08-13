import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Download, Play, Terminal, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiGet, apiPost, apiPut, type Ori } from "@/lib/api";
import { RUNNABLE, fmtTime, stateVariant, stopsIn } from "@/lib/oris";

export function OriDetail({ oriId }: { oriId: string }) {
  const [ori, setOri] = useState<Ori | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ ori: Ori }>(`/oris/${oriId}`);
      setOri(r.ori);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [oriId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => !document.hidden && void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!ori) return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <a href="#/oris" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm">
          <ArrowLeft className="size-4" /> Oris
        </a>
        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold">{ori.name}</h1>
          <span className="mono text-muted-foreground text-sm">{ori.id}</span>
          <Badge variant={stateVariant(ori.state)}>{ori.state}</Badge>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="console">Console</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><Overview ori={ori} /></TabsContent>
        <TabsContent value="events"><Events oriId={ori.id} /></TabsContent>
        <TabsContent value="console"><Console ori={ori} /></TabsContent>
        <TabsContent value="files"><Files ori={ori} /></TabsContent>
        <TabsContent value="snapshots"><Snapshots oriId={ori.id} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Overview({ ori }: { ori: Ori }) {
  const rows: Array<[string, string]> = [
    ["Type", `${ori.type}${ori.vcpu ? ` · ${ori.vcpu} vCPU · ${ori.memoryGB} GB` : ""}`],
    ["State", ori.state],
    ["Stops in", stopsIn(ori) ?? "—"],
    ["IP", ori.ip ?? "— (published on a loopback port; use ori ssh)"],
    ["Subdomain", ori.subdomain ?? "—"],
    ["Created", fmtTime(ori.createdAt)],
    ["Updated", fmtTime(ori.updatedAt)],
    ["Last snapshot", fmtTime(ori.snapshotCompletedAt)],
  ];
  return (
    <Card>
      <CardContent>
        <dl className="divide-border divide-y text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="mono text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function Events({ oriId }: { oriId: string }) {
  const [events, setEvents] = useState<any[]>([]);
  // Distinguished from "loaded and empty" on purpose: rendering "No events." during the fetch
  // states something false, and for a fresh ori it is the answer the user is actually waiting on.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
    void (async () => {
      try {
        const r = await apiGet<{ events?: any[] }>(`/oris/${oriId}/events?limit=100`);
        setEvents((r.events ?? []).slice().reverse());
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load events");
      } finally {
        setLoaded(true);
      }
    })();
  }, [oriId]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        {!loaded ? (
          <p className="text-muted-foreground py-6 text-center text-sm">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">No events.</p>
        ) : (
          events.map((e, i) => (
            <div key={e.id ?? i} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="mono font-medium">{e.type}</span>
                <span className="text-muted-foreground text-xs">{fmtTime(e.timestamp ?? e.createdAt)}</span>
              </div>
              {e.data && Object.keys(e.data).length > 0 && (
                <pre className="mono text-muted-foreground mt-1 overflow-x-auto text-xs">{JSON.stringify(e.data)}</pre>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function Console({ ori }: { ori: Ori }) {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const runnable = RUNNABLE.includes(ori.state);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await apiPost(`/oris/${ori.id}/commands`, { command }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Command failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Run a command</CardTitle>
        <CardDescription>
          Runs as <code className="mono">user</code> in <code className="mono">/home/user</code>.
          Capped at 60 seconds by the server — use <code className="mono">ori ssh</code> for
          anything longer.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input
            className="mono"
            placeholder="uname -a"
            value={command}
            disabled={!runnable}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && command.trim() && void run()}
          />
          <Button onClick={run} disabled={busy || !runnable || !command.trim()}>
            <Terminal /> {busy ? "Running…" : "Run"}
          </Button>
        </div>
        {!runnable && <p className="text-muted-foreground text-xs">The ori must be running.</p>}
        {result && (
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground flex gap-4 text-xs">
              <span>exit {result.exitCode ?? "—"}</span>
              {result.signal && <span>signal {result.signal}</span>}
              {result.timedOut && <span className="text-warning">timed out</span>}
              {result.stdoutTruncated && <span className="text-warning">stdout truncated</span>}
              {result.stderrTruncated && <span className="text-warning">stderr truncated</span>}
            </div>
            {result.stdout && <pre className="mono bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{result.stdout}</pre>}
            {result.stderr && <pre className="mono bg-destructive/10 text-destructive max-h-60 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{result.stderr}</pre>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Files({ ori }: { ori: Ori }) {
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const runnable = RUNNABLE.includes(ori.state);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Files</CardTitle>
        <CardDescription>One path at a time, relative to the ori's home.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-2">
          <Label htmlFor="f-path">Path</Label>
          <Input id="f-path" className="mono" placeholder="notes/todo.txt" value={path} disabled={!runnable} onChange={(e) => setPath(e.target.value)} />
        </div>
        <Textarea className="mono min-h-40" placeholder="file contents" value={content} disabled={!runnable} onChange={(e) => setContent(e.target.value)} />
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy || !runnable || !path.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await apiGet<{ content: string }>(`/oris/${ori.id}/files?path=${encodeURIComponent(path.trim())}`);
                setContent(r.content ?? "");
                toast.success("Loaded");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Read failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Download /> Read
          </Button>
          <Button
            disabled={busy || !runnable || !path.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await apiPut(`/oris/${ori.id}/files`, { path: path.trim(), content });
                toast.success("Written");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Write failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Upload /> Write
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Snapshots({ oriId }: { oriId: string }) {
  const [snaps, setSnaps] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
    void (async () => {
      try {
        const r = await apiGet<{ snapshots?: any[] }>(`/oris/${oriId}/snapshots`);
        setSnaps(r.snapshots ?? []);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load snapshots");
      } finally {
        setLoaded(true);
      }
    })();
  }, [oriId]);

  return (
    <Card>
      <CardContent>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Gen</TableHead>
                <TableHead>Files</TableHead>
                <TableHead>Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loaded ? (
                <TableRow><TableCell colSpan={5} className="text-muted-foreground py-10 text-center">Loading…</TableCell></TableRow>
              ) : snaps.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-muted-foreground py-10 text-center">No snapshots yet. Stopping the ori creates one.</TableCell></TableRow>
              ) : (
                snaps.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-xs">{fmtTime(s.completedAt ?? s.createdAt)}</TableCell>
                    <TableCell><Badge variant="secondary">{s.kind}</Badge></TableCell>
                    <TableCell className="mono text-xs">{s.generation}</TableCell>
                    <TableCell className="mono text-xs">{s.fileCount ?? "—"}</TableCell>
                    <TableCell className="mono text-xs">{s.sizeBytes ? `${(s.sizeBytes / 1e6).toFixed(1)} MB` : "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
