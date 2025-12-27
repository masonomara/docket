import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router";
import type { MetaFunction } from "react-router";
import { signIn, signUp, authClient, API_URL } from "~/lib/auth-client";
import type { InvitationDetails } from "~/lib/types";
import styles from "~/styles/auth.module.css";

export const meta: MetaFunction = () => [
  { title: "Sign In | Docket" },
  { name: "description", content: "Sign in or create your Docket account" },
];

// The auth flow is a simple state machine:
// 1. "email" - User enters their email, we check if they exist
// 2. "login" - User exists with password, show password field
// 3. "signup" - User doesn't exist, collect name + password
// 4. "oauth-only" - User exists but signed up via Google, prompt to use Google
type AuthStep = "email" | "login" | "signup" | "oauth-only";

export default function AuthPage() {
  const [searchParams] = useSearchParams();
  const invitationId = searchParams.get("invitation");

  // Where to redirect after auth completes
  const redirectParam = searchParams.get("redirect") || "/dashboard";
  const redirectUrl = invitationId
    ? `/accept-invite?invitation=${invitationId}`
    : redirectParam;

  // Core auth state
  const [step, setStep] = useState<AuthStep>("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Invitation state (when user clicks an invite link)
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [invitationLoading, setInvitationLoading] = useState(!!invitationId);

  // Email verification state (after signup)
  const [emailSent, setEmailSent] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [hasResent, setHasResent] = useState(false);

  // Load invitation details if we have an invitation ID
  useEffect(() => {
    if (!invitationId) return;

    async function loadInvitation() {
      try {
        const res = await fetch(`${API_URL}/api/invitations/${invitationId}`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = (await res.json()) as InvitationDetails;
          setInvitation(data);
          setEmail(data.email); // Pre-fill the email from the invitation
        }
      } catch {
        // If invitation fetch fails, just continue with normal auth flow
      } finally {
        setInvitationLoading(false);
      }
    }

    loadInvitation();
  }, [invitationId]);

  // Reset form when going back to email step
  function handleChangeEmail() {
    setStep("email");
    setPassword("");
    setName("");
    setErrorMessage(null);
  }

  // Check if email exists and route to appropriate step
  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/check-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.toLowerCase().trim() }),
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error("Failed to check email");
      }

      const data = (await res.json()) as {
        exists: boolean;
        hasPassword: boolean;
      };

      // Route to the appropriate step based on account status
      if (data.exists && data.hasPassword) {
        setStep("login");
      } else if (data.exists) {
        setStep("oauth-only");
      } else {
        setStep("signup");
      }
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  // Handle password login
  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    try {
      await signIn.email(
        { email, password },
        {
          onSuccess: () => {
            window.location.href = redirectUrl;
          },
          onError: (ctx) => {
            setErrorMessage(ctx.error.message || "Invalid email or password");
            setIsLoading(false);
          },
        }
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Login failed");
      setIsLoading(false);
    }
  }

  // Handle new account signup
  async function handleSignupSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    await signUp.email(
      {
        name,
        email,
        password,
        callbackURL: `${window.location.origin}${redirectUrl}`,
      },
      {
        onSuccess: () => {
          setEmailSent(true);
          setIsLoading(false);
        },
        onError: (ctx) => {
          setErrorMessage(ctx.error.message || "Failed to create account");
          setIsLoading(false);
        },
      }
    );
  }

  // Resend verification email
  async function handleResendVerification() {
    setIsResending(true);
    setHasResent(false);

    await authClient.sendVerificationEmail({
      email,
      callbackURL: `${window.location.origin}${redirectUrl}`,
    });

    setIsResending(false);
    setHasResent(true);
  }

  // Social login (Google)
  function handleGoogleSignIn() {
    signIn.social({
      provider: "google",
      callbackURL: `${window.location.origin}${redirectUrl}`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: Loading invitation
  // ─────────────────────────────────────────────────────────────────────────────
  if (invitationLoading) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <p className={styles.subtitle}>Loading invitation...</p>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: Invitation expired
  // ─────────────────────────────────────────────────────────────────────────────
  if (invitation?.isExpired) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Invitation Expired</h1>
          <p className={styles.subtitle}>
            This invitation to join {invitation.orgName} has expired. Please
            contact your organization admin.
          </p>
          <Link
            to="/auth"
            className={`btn btn-primary btn-lg ${styles.fullWidthButton}`}
          >
            Back to Sign In
          </Link>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: Invitation already accepted
  // ─────────────────────────────────────────────────────────────────────────────
  if (invitation?.isAccepted) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Already Accepted</h1>
          <p className={styles.subtitle}>
            This invitation has already been accepted.
          </p>
          <Link
            to="/auth"
            className={`btn btn-primary btn-lg ${styles.fullWidthButton}`}
          >
            Back to Sign In
          </Link>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: Email verification sent (after signup)
  // ─────────────────────────────────────────────────────────────────────────────
  if (emailSent) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Check your email</h1>
          <p className={styles.subtitle}>
            We sent a verification link to <strong>{email}</strong>. Click the
            link to verify your account.
          </p>

          {hasResent && (
            <p className="alert alert-success">Verification email resent!</p>
          )}

          <button
            type="button"
            onClick={handleResendVerification}
            disabled={isResending}
            className={`btn btn-primary btn-lg ${styles.fullWidthButton}`}
          >
            {isResending ? "Resending..." : "Resend verification email"}
          </button>

          <p className={styles.footer}>
            Wrong email?{" "}
            <button
              type="button"
              onClick={() => {
                setEmailSent(false);
                setHasResent(false);
              }}
              className={styles.linkButton}
            >
              Go back
            </button>
          </p>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: Step 1 - Enter email
  // ─────────────────────────────────────────────────────────────────────────────
  if (step === "email") {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Work with Docket Case Management</h1>
          <p className={styles.subtitle}>
            {invitation
              ? `${invitation.inviterName} invited you to join ${invitation.orgName}. Sign in or create an account.`
              : "Sign in or create an account to work with Docket."}
          </p>

          {errorMessage && (
            <div className="alert alert-error">{errorMessage}</div>
          )}

          {/* Google Sign In */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="btn btn-secondary btn-lg"
          >
            <img src="/google-icon-button.svg" alt="" height="18" width="18" />
            Continue with Google
          </button>

          <div className={styles.divider}>or</div>

          {/* Email form */}
          <form className={styles.formGroup} onSubmit={handleEmailSubmit}>
            <div className={styles.fieldGroup}>
              <label htmlFor="email" className={styles.label}>
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading || !!invitation}
                readOnly={!!invitation}
                className={`${styles.input} ${invitation ? styles.inputDisabled : ""}`}
                placeholder="Enter your email"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className={`btn btn-primary btn-lg ${styles.fullWidthButton}`}
            >
              {isLoading ? "Checking..." : "Continue"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: Step 2a - Login (existing user with password)
  // ─────────────────────────────────────────────────────────────────────────────
  if (step === "login") {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Welcome back</h1>
          <p className={styles.subtitle}>
            {invitation
              ? `Continue to Docket as a ${invitation.role} of ${invitation.orgName}.`
              : "Enter your password to continue"}
          </p>

          {errorMessage && (
            <div className="alert alert-error">{errorMessage}</div>
          )}

          <form className={styles.formGroup} onSubmit={handleLoginSubmit}>
            {/* Email field (read-only) */}
            <div className={styles.fieldGroup}>
              <label htmlFor="email" className={styles.label}>
                Email
              </label>
              <div className={styles.inputWithAction}>
                <input
                  id="email"
                  type="email"
                  value={email}
                  readOnly
                  disabled
                  className={`${styles.input} ${styles.inputDisabled}`}
                />
                {!invitation && (
                  <button
                    type="button"
                    onClick={handleChangeEmail}
                    className={styles.inlineAction}
                  >
                    Change
                  </button>
                )}
              </div>
            </div>

            {/* Password field */}
            <div className={styles.fieldGroup}>
              <label htmlFor="password" className={styles.label}>
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                className={styles.input}
                placeholder="Enter your password"
                autoFocus
              />
              <Link to="/forgot-password" className={styles.fieldLink}>
                Forgot password?
              </Link>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className={`btn btn-primary btn-lg ${styles.fullWidthButton}`}
            >
              {isLoading ? "Logging in..." : "Log in"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: Step 2b - OAuth only (user signed up with Google, no password)
  // ─────────────────────────────────────────────────────────────────────────────
  if (step === "oauth-only") {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Welcome back</h1>
          <p className={styles.subtitle}>
            This account uses Google sign-in. Continue with Google to access
            your account.
          </p>

          <div className={styles.oauthSection}>
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={isLoading}
              className="btn btn-secondary btn-lg"
            >
              <img
                src="/google-icon-button.svg"
                alt=""
                height="18"
                width="18"
              />
              Continue with Google
            </button>
          </div>

          <p className={styles.footer}>
            Not you?{" "}
            <button
              type="button"
              onClick={handleChangeEmail}
              className={styles.linkButton}
            >
              Use a different email
            </button>
          </p>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: Step 2c - Signup (new user)
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.subtitle}>
          {invitation ? (
            <>
              Join <strong>{invitation.orgName}</strong> as a {invitation.role}.
            </>
          ) : (
            "Sign up to get started with Docket."
          )}
        </p>

        {errorMessage && (
          <div className="alert alert-error">{errorMessage}</div>
        )}

        <form className={styles.formGroup} onSubmit={handleSignupSubmit}>
          {/* Email field (read-only) */}
          <div className={styles.fieldGroup}>
            <label htmlFor="email" className={styles.label}>
              Email
            </label>
            <div className={styles.inputWithAction}>
              <input
                id="email"
                type="email"
                value={email}
                readOnly
                disabled
                className={`${styles.input} ${styles.inputDisabled}`}
              />
              {!invitation && (
                <button
                  type="button"
                  onClick={handleChangeEmail}
                  className={styles.inlineAction}
                >
                  Change
                </button>
              )}
            </div>
          </div>

          {/* Name field */}
          <div className={styles.fieldGroup}>
            <label htmlFor="name" className={styles.label}>
              Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={isLoading}
              className={styles.input}
              placeholder="Enter your name"
              autoFocus
            />
          </div>

          {/* Password field */}
          <div className={styles.fieldGroup}>
            <label htmlFor="password" className={styles.label}>
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              disabled={isLoading}
              className={styles.input}
              placeholder="Create a password"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className={`btn btn-primary btn-lg ${styles.fullWidthButton}`}
          >
            {isLoading ? "Creating account..." : "Sign up"}
          </button>
        </form>
      </div>
    </main>
  );
}
