import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, Mail, KeyRound, Trash2 } from "lucide-react";
import { useSession } from "@supabase/auth-helpers-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabase-client";
import { apiRequest } from "@/lib/queryClient";

// Must match the signup form's rule (SignUpForm: "At least 8 characters").
export const MIN_PASSWORD_LENGTH = 8;

type Panel = null | "email" | "password" | "delete";

/**
 * Account basics: change email, change (or set) password, delete account.
 * Lives in the dashboard Settings dialog.
 */
export function AccountSettings() {
  const session = useSession();
  const user = session?.user;
  const [panel, setPanel] = useState<Panel>(null);

  // Google sign-ups have no password yet; they "set" one instead of "change".
  const hasPassword = !!user?.identities?.some((i) => i.provider === "email");

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  if (!user) {return null;}

  return (
    <div className="space-y-3" data-testid="account-settings">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Account</h3>

      <Row
        icon={<Mail className="h-4 w-4" />}
        title="Email"
        detail={user.new_email ? `${user.email} → ${user.new_email} (awaiting confirmation)` : user.email ?? ""}
        action={panel === "email" ? "Cancel" : "Change"}
        onAction={() => toggle("email")}
      />
      {panel === "email" && <ChangeEmail currentEmail={user.email ?? ""} onDone={() => setPanel(null)} />}

      <Row
        icon={<KeyRound className="h-4 w-4" />}
        title="Password"
        detail={hasPassword ? "••••••••" : "No password yet — you sign in with Google"}
        action={panel === "password" ? "Cancel" : hasPassword ? "Change" : "Set password"}
        onAction={() => toggle("password")}
      />
      {panel === "password" && (
        <ChangePassword email={user.email ?? ""} requireCurrent={hasPassword} onDone={() => setPanel(null)} />
      )}

      <Row
        icon={<Trash2 className="h-4 w-4" />}
        title="Delete account"
        detail="Permanently remove your profile, résumé and applications"
        action={panel === "delete" ? "Cancel" : "Delete"}
        onAction={() => toggle("delete")}
        destructive
      />
      {panel === "delete" && <DeleteAccount />}
    </div>
  );
}

function Row({ icon, title, detail, action, onAction, destructive }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
  destructive?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <span className={`mt-0.5 ${destructive ? "text-red-500" : "text-slate-500"}`}>{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-slate-500 break-all">{detail}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAction}
        className={destructive ? "text-red-600 border-red-200 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950" : ""}
      >
        {action}
      </Button>
    </div>
  );
}

function ChangeEmail({ currentEmail, onDone }: { currentEmail: string; onDone: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const next = email.trim().toLowerCase();
      if (next === currentEmail.toLowerCase()) {throw new Error("That's already your email.");}
      const { error } = await supabase.auth.updateUser(
        { email: next },
        { emailRedirectTo: `${window.location.origin}/candidate-dashboard` },
      );
      if (error) {throw error;}
      return next;
    },
    onSuccess: (next) => {
      toast({
        title: "Check your inbox",
        description: `We sent a confirmation link to ${next}. Your email changes once you click it — you may also need to confirm from ${currentEmail}.`,
      });
      onDone();
    },
    onError: (e: Error) => toast({ title: "Couldn't change email", description: e.message, variant: "destructive" }),
  });

  return (
    <form
      className="space-y-2 rounded-md border border-slate-200 dark:border-slate-700 p-3"
      onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
    >
      <Label htmlFor="new-email" className="text-xs">New email</Label>
      <Input id="new-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <Button type="submit" size="sm" disabled={mutation.isPending || !email} className="w-full">
        {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send confirmation link"}
      </Button>
    </form>
  );
}

function ChangePassword({ email, requireCurrent, onDone }: { email: string; requireCurrent: boolean; onDone: () => void }) {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (next.length < MIN_PASSWORD_LENGTH) {throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);}
      if (next !== confirm) {throw new Error("The new passwords don't match.");}
      if (requireCurrent) {
        // Re-verify before changing, so an unattended signed-in session can't
        // be used to take over the account.
        const { error } = await supabase.auth.signInWithPassword({ email, password: current });
        if (error) {throw new Error("Your current password is incorrect.");}
      }
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) {throw error;}
    },
    onSuccess: () => {
      toast({ title: requireCurrent ? "Password changed" : "Password set", description: "Use it next time you sign in." });
      onDone();
    },
    onError: (e: Error) => toast({ title: "Couldn't update password", description: e.message, variant: "destructive" }),
  });

  return (
    <form
      className="space-y-2 rounded-md border border-slate-200 dark:border-slate-700 p-3"
      onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
    >
      {requireCurrent && (
        <>
          <Label htmlFor="current-password" className="text-xs">Current password</Label>
          <Input id="current-password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </>
      )}
      <Label htmlFor="new-password" className="text-xs">New password</Label>
      <Input id="new-password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} />
      <Label htmlFor="confirm-password" className="text-xs">Confirm new password</Label>
      <Input id="confirm-password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <p className="text-xs text-slate-500">At least {MIN_PASSWORD_LENGTH} characters.</p>
      <Button type="submit" size="sm" disabled={mutation.isPending || !next || !confirm || (requireCurrent && !current)} className="w-full">
        {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : requireCurrent ? "Change password" : "Set password"}
      </Button>
    </form>
  );
}

function DeleteAccount() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [typed, setTyped] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/account", { confirm: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Account deletion failed.");
      }
    },
    onSuccess: async () => {
      await supabase.auth.signOut().catch(() => {});
      toast({ title: "Account deleted", description: "Your data has been removed. Sorry to see you go." });
      setLocation("/");
    },
    onError: (e: Error) => toast({ title: "Couldn't delete account", description: e.message, variant: "destructive" }),
  });

  return (
    <form
      className="space-y-2 rounded-md border border-red-200 dark:border-red-900 p-3"
      onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
    >
      <p className="text-xs text-slate-600 dark:text-slate-300">
        This permanently deletes your profile, résumé, saved jobs and applications. It can't be undone.
      </p>
      <Label htmlFor="confirm-delete" className="text-xs">Type <span className="font-mono font-semibold">DELETE</span> to confirm</Label>
      <Input id="confirm-delete" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <Button type="submit" size="sm" variant="destructive" disabled={mutation.isPending || typed !== "DELETE"} className="w-full">
        {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete my account"}
      </Button>
    </form>
  );
}
