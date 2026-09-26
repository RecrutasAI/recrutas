import { useState, useEffect } from "react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Link, useLocation } from "wouter"
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react"
import { supabase } from "@/lib/supabase-client"
import { MIN_PASSWORD_LENGTH } from "@/components/account-settings"

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [isRecoveryMode, setIsRecoveryMode] = useState(false)
  const [isComplete, setIsComplete] = useState(false)
  const { toast } = useToast()
  const [, setLocation] = useLocation()

  useEffect(() => {
    // Check if we're already in a recovery session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {setIsRecoveryMode(true)}
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setIsRecoveryMode(true)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const updatePasswordMutation = useMutation({
    mutationFn: async (newPassword: string) => {
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) {throw error}
    },
    onSuccess: () => {
      setIsComplete(true)
      toast({
        title: "Password updated",
        description: "Your password has been reset successfully.",
      })
      setTimeout(() => setLocation("/auth"), 3000)
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update password. Please try again.",
        variant: "destructive",
      })
    },
  })

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (password !== confirmPassword) {
      toast({
        title: "Passwords don't match",
        description: "Please make sure both passwords are the same.",
        variant: "destructive",
      })
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast({
        title: "Password too short",
        description: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        variant: "destructive",
      })
      return
    }
    updatePasswordMutation.mutate(password)
  }

  if (isComplete) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <Card className="border border-border shadow-lg">
            <CardHeader className="text-center pb-4">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
              <CardTitle className="text-foreground text-xl">Password updated</CardTitle>
              <CardDescription className="text-muted-foreground">
                Your password has been reset successfully. Redirecting to sign in...
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/auth">
                <Button variant="outline" className="w-full">
                  Go to sign in
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  if (!isRecoveryMode) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <Card className="border border-border shadow-lg">
            <CardHeader className="text-center pb-4">
              <CardTitle className="text-foreground text-xl">Invalid or expired link</CardTitle>
              <CardDescription className="text-muted-foreground">
                This password reset link is invalid or has expired. Please request a new one.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Link href="/forgot-password">
                <Button className="w-full">Request new reset link</Button>
              </Link>
              <Link href="/auth">
                <Button variant="ghost" className="w-full">Back to sign in</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4 relative">
      <Link href="/auth" className="absolute top-4 left-4 flex items-center space-x-2 text-muted-foreground hover:text-foreground transition-colors duration-200">
        <ArrowLeft className="w-4 h-4" />
        <span className="text-sm">Back to sign in</span>
      </Link>

      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-foreground">Set new password</h1>
          <p className="text-muted-foreground mt-2">
            Enter your new password below.
          </p>
        </div>

        <Card className="border border-border shadow-lg">
          <CardHeader className="pb-4">
            <CardTitle className="text-foreground text-xl">Reset password</CardTitle>
            <CardDescription className="text-muted-foreground">
              Choose a strong password for your account
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password" className="text-foreground">New password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter new password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  className="border-input focus:border-ring h-11"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-foreground">Confirm password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  className="border-input focus:border-ring h-11"
                />
              </div>

              <Button
                type="submit"
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors duration-200 h-11"
                disabled={updatePasswordMutation.isPending || !password || !confirmPassword}
              >
                {updatePasswordMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : (
                  "Update password"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}