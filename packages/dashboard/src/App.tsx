import { useCallback, useEffect, useState } from "react";
import { Boxes as OrisIcon, KeyRound, LogOut, Moon, Sun, User, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Mark } from "@/components/Mark";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { apiGet, authPost, setStoredKey, setUnauthorizedHandler, storedKey } from "@/lib/api";
import { AuthPage } from "@/views/Auth";
import { OrisView } from "@/views/Oris";
import { OriDetail } from "@/views/OriDetail";
import { SecretsView } from "@/views/Secrets";
import { ApiKeysView } from "@/views/ApiKeys";
import { AccountView } from "@/views/Account";

const NAV = [
  { id: "oris", label: "Oris", icon: OrisIcon },
  { id: "secrets", label: "Secrets", icon: Lock },
  { id: "api-keys", label: "API Keys", icon: KeyRound },
  { id: "account", label: "Account", icon: User },
] as const;

/** `#/oris`, `#/ori/or_xxxxxxxx`, … A hash router, because the app is served from a subpath. */
function useHashRoute(): string[] {
  const [hash, setHash] = useState(() => location.hash.replace(/^#\/?/, ""));
  useEffect(() => {
    const on = () => setHash(location.hash.replace(/^#\/?/, ""));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.split("/").filter(Boolean);
}

export function App() {
  const parts = useHashRoute();
  const [authed, setAuthed] = useState<boolean | null>(null);

  const check = useCallback(async () => {
    try {
      await apiGet("/me");
      setAuthed(true);
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setStoredKey(null);
      setAuthed(false);
    });
    void check();
  }, [check]);

  if (authed === null) {
    return <div className="text-muted-foreground flex min-h-svh items-center justify-center text-sm">Loading…</div>;
  }
  if (!authed) {
    return (
      <AuthPage
        onAuthed={() => {
          setAuthed(true);
          if (!location.hash) location.hash = "#/oris";
        }}
      />
    );
  }

  const active = parts[0] === "ori" ? "oris" : (parts[0] ?? "oris");
  return (
    <div className="flex min-h-svh">
      <Sidebar active={active} onSignedOut={() => setAuthed(false)} />
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-5xl p-6 md:p-10">
          {parts[0] === "ori" && parts[1] ? (
            <OriDetail oriId={parts[1]} />
          ) : active === "secrets" ? (
            <SecretsView />
          ) : active === "api-keys" ? (
            <ApiKeysView />
          ) : active === "account" ? (
            <AccountView />
          ) : (
            <OrisView />
          )}
        </div>
      </main>
    </div>
  );
}

function Sidebar({ active, onSignedOut }: { active: string; onSignedOut: () => void }) {
  const { theme, setTheme } = useTheme();
  const usingKey = !!storedKey();

  async function signOut() {
    // Clear both credentials: a session cookie AND any pasted key, or "sign out" would leave one
    // of the two still working.
    try {
      await authPost("/logout");
    } catch {
      /* a dead session is still signed out */
    }
    setStoredKey(null);
    onSignedOut();
  }

  return (
    <aside className="bg-card/40 flex w-[230px] shrink-0 flex-col justify-between border-r p-4">
      <div>
        <div className="flex items-center gap-2.5 px-2 py-4">
          <Mark className="size-9" />
          <span className="text-4xl font-extralight tracking-tight">ori</span>
        </div>
        <nav aria-label="Dashboard" className="mt-4 flex flex-col gap-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#/${id}`}
              aria-current={active === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-[background-color,color] duration-100",
                active === id ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </a>
          ))}
        </nav>
      </div>

      <div className="flex flex-col gap-2">
        <div className="bg-muted flex rounded-lg p-[3px]">
          {(["light", "dark"] as const).map((t) => (
            <button
              key={t}
              type="button"
              data-theme={t}
              onClick={() => setTheme(t)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs capitalize transition-[background-color,color,scale] duration-100 active:scale-[0.96] motion-reduce:active:scale-100",
                theme === t ? "bg-background text-foreground font-medium shadow-sm" : "text-muted-foreground",
              )}
            >
              {t === "light" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              {t}
            </button>
          ))}
        </div>
        {usingKey && <p className="text-muted-foreground px-1 text-[11px]">Signed in with an API key</p>}
        <Button variant="ghost" size="sm" onClick={signOut} className="text-muted-foreground hover:text-destructive justify-start">
          <LogOut /> Sign out
        </Button>
      </div>
    </aside>
  );
}
