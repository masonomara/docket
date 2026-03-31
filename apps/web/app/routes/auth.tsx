import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router";
import type { MetaFunction } from "react-router";
import {
  signIn,
  signUp,
  sendVerificationEmail,
  API_URL,
} from "~/lib/auth-client";
import { ENDPOINTS } from "~/lib/api";
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

  // Build redirect URL based on whether there's an invitation
  const redirectUrl = invitationId
    ? `/accept-invite?invitation=${invitationId}`
    : searchParams.get("redirect") || "/admin";

  // Auth flow state
  const [step, setStep] = useState<AuthStep>("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Invitation state
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [invitationLoading, setInvitationLoading] = useState(!!invitationId);

  // Email verification state
  const [emailSent, setEmailSent] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [hasResent, setHasResent] = useState(false);

  // Fetch invitation details if there's an invitation ID
  useEffect(() => {
    if (!invitationId) return;

    const id = invitationId; // Capture for closure

    async function fetchInvitation() {
      try {
        const res = await fetch(`${API_URL}${ENDPOINTS.invitations.get(id)}`, {
          credentials: "include",
        });

        if (res.ok) {
          const data = (await res.json()) as InvitationDetails;
          setInvitation(data);
          setEmail(data.email);
        }
      } catch {
        // Silently fail - invitation not found is handled in UI
      }

      setInvitationLoading(false);
    }

    fetchInvitation();
  }, [invitationId]);

  function resetToEmailStep() {
    setStep("email");
    setPassword("");
    setName("");
    setErrorMessage(null);
  }

  function handleGoogleSignIn() {
    signIn.social({
      provider: "google",
      callbackURL: `${window.location.origin}${redirectUrl}`,
    });
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.auth.checkEmail}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.toLowerCase().trim() }),
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error();
      }

      const data = (await res.json()) as {
        exists: boolean;
        hasPassword: boolean;
      };

      if (data.exists) {
        // User exists - either show password login or OAuth-only screen
        setStep(data.hasPassword ? "login" : "oauth-only");
      } else {
        // New user - show signup form
        setStep("signup");
      }
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

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

  async function handleResendVerification() {
    setIsResending(true);
    setHasResent(false);

    await sendVerificationEmail({
      email,
      callbackURL: `${window.location.origin}${redirectUrl}`,
    });

    setIsResending(false);
    setHasResent(true);
  }

  function handleGoBackFromEmailSent() {
    setEmailSent(false);
    setHasResent(false);
  }

  // Loading state while fetching invitation
  if (invitationLoading) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <p className="text-body text-secondary">Loading invitation...</p>
        </div>
      </main>
    );
  }

  // Invitation expired
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

  // Invitation already accepted
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

  // Email verification sent screen
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

  // Step 1: Enter email
  if (step === "email") {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1
            className="text-large-title"
            style={{ textAlign: "center", maxWidth: "10em" }}
          >
            Work with Docket Case Management
          </h1>

          <p className={styles.subtitle}>
            {invitation
              ? `${invitation.inviterName} invited you to join ${invitation.orgName}. Sign in or create an account.`
              : "Sign in or create an account to work with Docket."}
          </p>

          {errorMessage && (
            <div className="alert alert-error">{errorMessage}</div>
          )}

          <GoogleSignInButton
            onClick={handleGoogleSignIn}
            disabled={isLoading}
          />

          <div className={styles.divider}>or</div>

          <form className={styles.formGroup} onSubmit={handleEmailSubmit}>
            <EmailField
              email={email}
              onChange={setEmail}
              disabled={isLoading || !!invitation}
              readOnly={!!invitation}
            />
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

  // Step 2a: Login with password
  if (step === "login") {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className="text-large-title" style={{ textAlign: "center" }}>
            Welcome back
          </h1>

          <p className={styles.subtitle}>
            {invitation
              ? `Continue to Docket as a ${invitation.role} of ${invitation.orgName}.`
              : "Enter your password to continue"}
          </p>

          {errorMessage && (
            <div className="alert alert-error">{errorMessage}</div>
          )}

          <form className={styles.formGroup} onSubmit={handleLoginSubmit}>
            <ReadOnlyEmailField
              email={email}
              showChangeButton={!invitation}
              onChangeClick={resetToEmailStep}
            />

            <div className="form-group" style={{ marginBottom: "16px" }}>
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
                className="form-input"
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

  // Step 2b: OAuth-only account (no password)
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

          <div className={styles.oauthSection}>
            <GoogleSignInButton
              onClick={handleGoogleSignIn}
              disabled={isLoading}
            />
          </div>

          <p className={styles.footer}>
            Not you?{" "}
            <button
              type="button"
              onClick={resetToEmailStep}
              className={styles.linkButton}
            >
              Use a different email
            </button>
          </p>
        </div>
      </main>
    );
  }

  // Step 3: Create account (signup)
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className="text-large-title" style={{ textAlign: "center" }}>
          Create your account
        </h1>

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
          <ReadOnlyEmailField
            email={email}
            showChangeButton={!invitation}
            onChangeClick={resetToEmailStep}
          />

          <div className="form-input">
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
              className="form-input"
              placeholder="Enter your name"
              autoFocus
            />
          </div>

          <div className="form-input">
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
              className="form-input"
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

// ============================================================================
// Helper Components
// ============================================================================

interface GoogleSignInButtonProps {
  onClick: () => void;
  disabled: boolean;
}

function GoogleSignInButton({ onClick, disabled }: GoogleSignInButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="btn btn-secondary btn-lg"
    >
      <img src="/google-icon-button.svg" alt="" height="18" width="18" />
      Continue with Google
    </button>
  );
}

interface EmailFieldProps {
  email: string;
  onChange: (value: string) => void;
  disabled: boolean;
  readOnly: boolean;
}

function EmailField({ email, onChange, disabled, readOnly }: EmailFieldProps) {
  const inputClassName = readOnly
    ? `${styles.input} ${styles.inputDisabled}`
    : styles.input;

  return (
    <div className="form-group" style={{ marginBottom: "16px" }}>
      <label htmlFor="email" className={styles.label}>
        Email
      </label>
      <input
        id="email"
        type="email"
        value={email}
        onChange={(e) => onChange(e.target.value)}
        required
        disabled={disabled}
        readOnly={readOnly}
        className="form-input"
        placeholder="Enter your email"
      />
    </div>
  );
}

interface ReadOnlyEmailFieldProps {
  email: string;
  showChangeButton: boolean;
  onChangeClick: () => void;
}

function ReadOnlyEmailField({
  email,
  showChangeButton,
  onChangeClick,
}: ReadOnlyEmailFieldProps) {
  return (
    <div className="form-group" style={{ marginBottom: "16px" }}>
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
          className="form-input input-disabled"
        />
        {showChangeButton && (
          <button
            type="button"
            onClick={onChangeClick}
            className={styles.inlineAction}
          >
            Change
          </button>
        )}
      </div>
    </div>
  );
}
