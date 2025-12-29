import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router";
import type { MetaFunction } from "react-router";
import {
  signIn,
  signUp,
  sendVerificationEmail,
  API_URL,
} from "~/lib/auth-client";
import type { InvitationDetails } from "~/lib/types";
import styles from "~/styles/auth.module.css";

export const meta: MetaFunction = () => [
  { title: "Sign In | Docket" },
  { name: "description", content: "Sign in or create your Docket account" },
];

type AuthStep = "email" | "login" | "signup" | "oauth-only";

export default function AuthPage() {
  const [searchParams] = useSearchParams();
  const invitationId = searchParams.get("invitation");
  const redirectParam = searchParams.get("redirect") || "/dashboard";

  // If there's an invitation, redirect to accept-invite after auth
  const redirectUrl = invitationId
    ? `/accept-invite?invitation=${invitationId}`
    : redirectParam;

  // Form state
  const [step, setStep] = useState<AuthStep>("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Invitation state
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [invitationLoading, setInvitationLoading] = useState(!!invitationId);

  // Email verification state
  const [emailSent, setEmailSent] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [hasResent, setHasResent] = useState(false);

  // Load invitation details if we have an invitation ID
  useEffect(() => {
    if (!invitationId) {
      return;
    }

    async function loadInvitation() {
      try {
        const response = await fetch(
          `${API_URL}/api/invitations/${invitationId}`,
          { credentials: "include" }
        );

        if (response.ok) {
          const data = (await response.json()) as InvitationDetails;
          setInvitation(data);
          setEmail(data.email);
        }
      } catch {
        // Invitation not found or error - continue without it
      }

      setInvitationLoading(false);
    }

    loadInvitation();
  }, [invitationId]);

  // Reset form when changing email
  function handleChangeEmail() {
    setStep("email");
    setPassword("");
    setName("");
    setErrorMessage(null);
  }

  // Check if email exists and determine next step
  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/check-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.toLowerCase().trim() }),
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Failed to check email");
      }

      const data = (await response.json()) as {
        exists: boolean;
        hasPassword: boolean;
      };

      // Determine which step to show based on account status
      if (data.exists) {
        if (data.hasPassword) {
          setStep("login");
        } else {
          setStep("oauth-only");
        }
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
      const message = err instanceof Error ? err.message : "Login failed";
      setErrorMessage(message);
      setIsLoading(false);
    }
  }

  // Handle new account signup
  async function handleSignupSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    const callbackURL = `${window.location.origin}${redirectUrl}`;

    await signUp.email(
      { name, email, password, callbackURL },
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

    const callbackURL = `${window.location.origin}${redirectUrl}`;
    await sendVerificationEmail({ email, callbackURL });

    setIsResending(false);
    setHasResent(true);
  }

  // Redirect to Google OAuth
  function handleGoogleSignIn() {
    const callbackURL = `${window.location.origin}${redirectUrl}`;
    signIn.social({ provider: "google", callbackURL });
  }

  // Go back from email sent screen
  function handleGoBackFromEmailSent() {
    setEmailSent(false);
    setHasResent(false);
  }

  // --- Render helpers ---

  function renderGoogleButton() {
    return (
      <button
        type="button"
        onClick={handleGoogleSignIn}
        disabled={isLoading}
        className="btn btn-secondary btn-lg"
      >
        <img src="/google-icon-button.svg" alt="" height="18" width="18" />
        Continue with Google
      </button>
    );
  }

  function renderEmailField(options: { editable?: boolean }) {
    const { editable = false } = options;

    if (editable) {
      return (
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
      );
    }

    // Read-only email with optional change button
    return (
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
    );
  }

  // --- Loading state ---
  if (invitationLoading) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <p className="text-body text-secondary">Loading invitation...</p>
        </div>
      </main>
    );
  }

  // --- Expired invitation ---
  if (invitation?.isExpired) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className="text-large-title" style={{ textAlign: "center" }}>
            Invitation Expired
          </h1>
          <p className={styles.subtitle}>
            This invitation to join {invitation.orgName} has expired. Please
            contact your firm admin.
          </p>
          <Link to="/auth" className="btn btn-primary btn-lg">
            Back to Sign In
          </Link>
        </div>
      </main>
    );
  }

  // --- Already accepted invitation ---
  if (invitation?.isAccepted) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className="text-large-title" style={{ textAlign: "center" }}>
            Already Accepted
          </h1>
          <p className={styles.subtitle}>
            This invitation has already been accepted.
          </p>
          <Link to="/auth" className="btn btn-primary btn-lg">
            Back to Sign In
          </Link>
        </div>
      </main>
    );
  }

  // --- Email verification sent ---
  if (emailSent) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className="text-large-title" style={{ textAlign: "center" }}>
            Check your email
          </h1>
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
            className="btn btn-primary btn-lg"
          >
            {isResending ? "Resending..." : "Resend verification email"}
          </button>

          <p className={styles.footer}>
            Wrong email?{" "}
            <button
              type="button"
              onClick={handleGoBackFromEmailSent}
              className={styles.linkButton}
            >
              Go back
            </button>
          </p>
        </div>
      </main>
    );
  }

  // --- Step 1: Email entry ---
  if (step === "email") {
    const subtitle = invitation
      ? `${invitation.inviterName} invited you to join ${invitation.orgName}. Sign in or create an account.`
      : "Sign in or create an account to work with Docket.";

    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1
            className="text-large-title"
            style={{ textAlign: "center", maxWidth: "10em" }}
          >
            Work with Docket Case Management
          </h1>
          <p className={styles.subtitle}>{subtitle}</p>

          {errorMessage && (
            <div className="alert alert-error">{errorMessage}</div>
          )}

          {renderGoogleButton()}

          <div className={styles.divider}>or</div>

          <form className={styles.formGroup} onSubmit={handleEmailSubmit}>
            {renderEmailField({ editable: true })}
            <button
              type="submit"
              disabled={isLoading}
              className="btn btn-primary btn-lg"
            >
              {isLoading ? "Checking..." : "Continue"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // --- Step 2a: Password login for existing user ---
  if (step === "login") {
    const subtitle = invitation
      ? `Continue to Docket as a ${invitation.role} of ${invitation.orgName}.`
      : "Enter your password to continue";

    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className="text-large-title" style={{ textAlign: "center" }}>
            Welcome back
          </h1>
          <p className={styles.subtitle}>{subtitle}</p>

          {errorMessage && (
            <div className="alert alert-error">{errorMessage}</div>
          )}

          <form className={styles.formGroup} onSubmit={handleLoginSubmit}>
            {renderEmailField({ editable: false })}

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
              className="btn btn-primary btn-lg"
            >
              {isLoading ? "Logging in..." : "Log in"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // --- Step 2b: OAuth-only user (no password set) ---
  if (step === "oauth-only") {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className="text-large-title" style={{ textAlign: "center" }}>
            Welcome back
          </h1>
          <p className={styles.subtitle}>
            This account uses Google sign-in. Continue with Google to access
            your account.
          </p>

          <div className={styles.oauthSection}>{renderGoogleButton()}</div>

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

  // --- Step 2c: New user signup ---
  const signupSubtitle = invitation ? (
    <>
      Join <strong>{invitation.orgName}</strong> as a {invitation.role}.
    </>
  ) : (
    "Sign up to get started with Docket."
  );

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className="text-large-title" style={{ textAlign: "center" }}>
          Create your account
        </h1>
        <p className={styles.subtitle}>{signupSubtitle}</p>

        {errorMessage && (
          <div className="alert alert-error">{errorMessage}</div>
        )}

        <form className={styles.formGroup} onSubmit={handleSignupSubmit}>
          {renderEmailField({ editable: false })}

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
            className="btn btn-primary btn-lg"
          >
            {isLoading ? "Creating account..." : "Sign up"}
          </button>
        </form>
      </div>
    </main>
  );
}
