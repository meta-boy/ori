import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiDelete, apiGet, apiPost, storedKey } from "@/lib/api";
import { fmtTime } from "@/lib/oris";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  keyLastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Create and revoke API keys.
 *
 * Both operations require a SESSION rather than a key, and the server enforces it. A bearer key
 * that could mint more bearer keys would be self-perpetuating: revoking it means nothing if the
 * holder already created replacements. So when you are signed in with a pasted key, the buttons
 * are disabled and say why, instead of offering an action that would 403.
 */
export function ApiKeysView() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [minted, setMinted] = useState<{ secret: string; name: string } | null>(null);

  // Whether this browser is authenticated by a pasted key rather than a password session.
  const usingKey = !!storedKey();

  const refresh = useCallback(async () => {
    try {
      const r = await apiGet<{ apiKeys?: ApiKey[] }>("/api-keys");
      setKeys(r.apiKeys ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load keys");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>
            For the CLI, SDKs and CI. <strong>Shown once at creation</strong> — only a hash is
            stored, so a lost key must be replaced rather than recovered.
          </CardDescription>
          <CardAction>
            <Button onClick={() => setCreating(true)} disabled={usingKey}>
              <Plus /> Create key
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {usingKey && (
            <p className="text-muted-foreground bg-muted/50 flex items-start gap-2 rounded-md p-3 text-xs">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                You are signed in with an API key, so creating and revoking are unavailable. A key
                that could mint more keys would survive its own revocation. Sign in with your email
                and password to manage keys.
              </span>
            </p>
          )}

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="w-11" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {!loaded ? (
                  <TableRow><TableCell colSpan={5} className="text-muted-foreground py-10 text-center">Loading…</TableCell></TableRow>
                ) : keys.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-muted-foreground py-10 text-center">No API keys yet.</TableCell></TableRow>
                ) : (
                  keys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="font-medium">{k.name}</TableCell>
                      <TableCell>
                        <span className="mono text-muted-foreground text-xs">{k.keyPrefix}_…{k.keyLastFour}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{fmtTime(k.createdAt)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {k.lastUsedAt ? fmtTime(k.lastUsedAt) : <Badge variant="secondary">never</Badge>}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost" size="icon-sm" aria-label={`Revoke ${k.name}`} title="Revoke"
                          disabled={usingKey} onClick={() => setRevoking(k)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(secret, name) => { setMinted({ secret, name }); void refresh(); }}
      />
      <RevealDialog minted={minted} onClose={() => setMinted(null)} />
      <RevokeDialog
        target={revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        onRevoked={() => { setRevoking(null); void refresh(); }}
      />
    </>
  );
}

function CreateDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (secret: string, name: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const r = await apiPost<{ secret: string }>("/api-keys", { name: name.trim() });
      onOpenChange(false);
      setName("");
      onCreated(r.secret, name.trim());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an API key</DialogTitle>
          <DialogDescription>Name it after where it will live, so a leak is traceable.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name" autoFocus placeholder="laptop, ci, staging-runner"
            value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && void create()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={busy || !name.trim()}>
            <KeyRound /> {busy ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The one and only sight of the secret.
 *
 * Deliberately harder to dismiss than a toast: no click-outside, no close button, and the copy
 * button has to be used or the text selected. Losing this value costs a new key, and a toast that
 * auto-dismisses in four seconds is the wrong container for something unrecoverable.
 */
function RevealDialog({ minted, onClose }: { minted: { secret: string; name: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (minted) setCopied(false); }, [minted]);

  return (
    <Dialog open={!!minted} onOpenChange={() => { /* modal on purpose: only the button closes it */ }}>
      <DialogContent
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="[&>button]:hidden"
      >
        <DialogHeader>
          <DialogTitle>Copy your key now</DialogTitle>
          <DialogDescription>
            This is the only time <strong>{minted?.name}</strong> is shown. Only its hash is
            stored, so it cannot be shown again — if you lose it, create another and revoke this one.
          </DialogDescription>
        </DialogHeader>

        <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
          <code className="mono min-w-0 flex-1 overflow-x-auto text-xs break-all">{minted?.secret}</code>
          <Button
            size="icon" variant="outline" aria-label="Copy key"
            onClick={async () => {
              if (!minted) return;
              try {
                await navigator.clipboard.writeText(minted.secret);
                setCopied(true);
              } catch {
                toast.info("Copy failed — select the text and copy manually");
              }
            }}
          >
            {copied ? <Check className="text-success" /> : <Copy />}
          </Button>
        </div>

        <p className="text-muted-foreground text-xs">
          Use it as <code className="mono">Authorization: Bearer …</code>, or{" "}
          <code className="mono">ori login &lt;key&gt;</code>.
        </p>

        <DialogFooter>
          <Button onClick={onClose} variant={copied ? "default" : "outline"}>
            {copied ? "Done" : "I have copied it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  target, onOpenChange, onRevoked,
}: { target: ApiKey | null; onOpenChange: (o: boolean) => void; onRevoked: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {target?.name}?</DialogTitle>
          <DialogDescription>
            Anything using <span className="mono">{target?.keyPrefix}_…{target?.keyLastFour}</span> stops
            working immediately. This cannot be undone; create a new key instead.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive" disabled={busy}
            onClick={async () => {
              if (!target) return;
              setBusy(true);
              try {
                await apiDelete(`/api-keys/${target.id}`);
                toast.success(`Revoked ${target.name}`);
                onRevoked();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Revoke failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Revoking…" : "Revoke key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
