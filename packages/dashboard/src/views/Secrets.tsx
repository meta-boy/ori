import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiGet, apiPost } from "@/lib/api";

type FileRow = { path: string; content: string };

/**
 * Account-wide secrets: env vars and files, applied to new oris.
 *
 * The API already enforces the limits (name pattern, ≤100 vars, 64KB total, no absolute paths, no
 * `..`), so this surfaces its errors rather than reimplementing the rules in the browser — two
 * validators would drift.
 */
export function SecretsView() {
  const [envText, setEnvText] = useState("");
  const [files, setFiles] = useState<FileRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await apiGet<{ envContents?: string; secretFiles?: FileRow[] }>("/secrets");
        setEnvText(r.envContents ?? "");
        setFiles(r.secretFiles ?? []);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load secrets");
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function save() {
    setBusy(true);
    try {
      await apiPost("/secrets", { envContents: envText, secretFiles: files.filter((f) => f.path.trim()) });
      toast.success("Secrets saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
        <CardDescription>Applied to new oris when they start.</CardDescription>
        <CardAction>
          <Button onClick={save} disabled={busy || !loaded}><Save /> {busy ? "Saving…" : "Save"}</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-2">
          <Label htmlFor="env">Environment variables</Label>
          <p className="text-muted-foreground text-xs">
            One <code className="mono">KEY=value</code> per line. Available as env vars and shell
            exports inside oris.
          </p>
          <Textarea id="env" className="mono min-h-40" value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={"GITHUB_TOKEN=ghp_…\nOPENAI_API_KEY=sk-…"} />
        </div>

        <div className="grid gap-2">
          <Label>Secret files</Label>
          <p className="text-muted-foreground text-xs">
            Written to relative paths inside the ori's home. Parent directories are created
            automatically; absolute paths and <code className="mono">..</code> are refused.
          </p>
          {files.map((f, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex gap-2">
                <Input className="mono" placeholder=".config/app/creds.json" value={f.path} onChange={(e) => setFiles(files.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)))} />
                <Button variant="ghost" size="icon" aria-label="Remove file" onClick={() => setFiles(files.filter((_, j) => j !== i))}><X /></Button>
              </div>
              <Textarea className="mono min-h-24" placeholder="file contents" value={f.content} onChange={(e) => setFiles(files.map((r, j) => (j === i ? { ...r, content: e.target.value } : r)))} />
            </div>
          ))}
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setFiles([...files, { path: "", content: "" }])}>
            <Plus /> Add file
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
