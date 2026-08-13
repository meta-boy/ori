import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api";

export function AccountView() {
  const [me, setMe] = useState<any>(null);
  const [limits, setLimits] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [m, l] = await Promise.all([apiGet("/me"), apiGet("/limits").catch(() => null)]);
        setMe(m);
        setLimits(l);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
  }, []);

  const rows: Array<[string, string]> = [
    ["Login", me?.user?.login ?? "—"],
    ["Email", me?.user?.email ?? "—"],
    ["Active oris", limits ? `${limits.activeOris ?? 0} / ${limits.maxActiveOris ?? "?"}` : "—"],
    ["Creations per minute", String(limits?.creationRatePerMinute ?? "—")],
    ["Creations per day", String(limits?.creationRequestsPerDay ?? "—")],
    ["Billing status", limits?.billingStatus ?? "—"],
    ["Can start", limits ? String(limits.canStart) : "—"],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Read-only. Limits come from the usage ledger.</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : (
          <dl className="divide-border divide-y text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-2.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="mono">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
