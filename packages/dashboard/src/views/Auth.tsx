import { useState } from "react";
import { KeyRound, LogIn, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Mark } from "@/components/Mark";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, authPost, setStoredKey } from "@/lib/api";

/**
 * Sign in, sign up, or paste an API key.
 *
 * The key tab is kept deliberately: it is the only way in before the first account exists, and
 * it is how the CLI authenticates. Signing in is preferred because the session is a HttpOnly
 * cookie the page never touches, whereas a pasted key has to be stored where script can read it.
 */
export function AuthPage({ onAuthed }: { onAuthed: () => void }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Mark className="mb-3 size-16" />
          <div className="text-5xl font-extralight tracking-tight">ori</div>
          <p className="text-muted-foreground mt-2 text-sm">self-hosted cloud sandboxes</p>
        </div>
        <Card>
          <Tabs defaultValue="login">
            <CardHeader>
              <TabsList className="w-full">
                <TabsTrigger value="login">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Sign up</TabsTrigger>
                <TabsTrigger value="key">API key</TabsTrigger>
              </TabsList>
            </CardHeader>
            <CardContent>
              <TabsContent value="login">
                <LoginForm onAuthed={onAuthed} />
              </TabsContent>
              <TabsContent value="signup">
                <SignupForm onAuthed={onAuthed} />
              </TabsContent>
              <TabsContent value="key">
                <KeyForm onAuthed={onAuthed} />
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>
      </div>
    </div>
  );
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function LoginForm({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await authPost("/login", { email, password });
    // A session supersedes any pasted key, and leaving a stale key behind would mean the next
    // request is judged on the key rather than the session.
    setStoredKey(null);
    onAuthed();
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="login-email">Email</Label>
        <Input id="login-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="login-password">Password</Label>
        <Input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full">
        <LogIn /> {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

function SignupForm({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await authPost("/signup", { email, password, invite });
    setStoredKey(null);
    onAuthed();
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="su-email">Email</Label>
        <Input id="su-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="su-password">Password</Label>
        <Input id="su-password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="text-muted-foreground text-xs">At least 10 characters.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="su-invite">Invite code</Label>
        <Input id="su-invite" className="mono" required value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="inv_…" />
        <p className="text-muted-foreground text-xs">
          Sign-up is invite-only. Mint one on the server with{" "}
          <code className="mono">bun scripts/create-invite.ts</code>.
        </p>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full">
        <UserPlus /> {busy ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}

function KeyForm({ onAuthed }: { onAuthed: () => void }) {
  const [key, setKey] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    setStoredKey(key.trim());
    try {
      // Prove the key works before committing to it, or a typo leaves the app in a logged-in
      // state that 401s on every screen.
      const res = await fetch("/api/ori/v1/me", { headers: { authorization: `Bearer ${key.trim()}` } });
      if (!res.ok) throw new ApiError(res.status, undefined, "That key was rejected.");
      onAuthed();
    } catch (e) {
      setStoredKey(null);
      throw e;
    }
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="api-key-input">API key</Label>
        <Input id="api-key-input" className="mono" required value={key} onChange={(e) => setKey(e.target.value)} placeholder="ori_live_…" />
        <p className="text-muted-foreground text-xs">
          Created with <code className="mono">bun scripts/create-key.ts</code>. Stored in this
          browser; signing in with a password is preferred because the session cookie cannot be
          read by script.
        </p>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Button type="submit" variant="secondary" disabled={busy} id="login-submit" className="w-full">
        <KeyRound /> {busy ? "Checking…" : "Use this key"}
      </Button>
    </form>
  );
}
