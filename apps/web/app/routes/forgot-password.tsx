import { useState } from "react";
import { Link } from "react-router";
import type { MetaFunction } from "react-router";
import { requestPasswordReset } from "~/lib/auth-client";
import styles from "~/styles/auth.module.css";

export const meta: MetaFunction = () => [
  { title: "Forgot Password | Docket" },
  { name: "description", content: "Reset your Docket password" },
];

/**
 * Forgot password page - allows users to request a password reset email.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Handles the password reset request form submission.
   */
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    const resetResult = await requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });

    setIsLoading(false);

    if (resetResult.error) {
      setErrorMessage(
        resetResult.error.message || "Failed to send reset email."
      );
    } else {
      setEmailSent(true);
    }
  }

  // Show success message after email is sent
  if (emailSent) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Check your email</h1>
          <p className={styles.subtitle}>
            If an account exists for <strong>{email}</strong>, we've sent a
            password reset link.
          </p>
          <p className={styles.footer}>
            <Link to="/auth" className={styles.footerLink}>
              Back to sign in
            </Link>
          </p>
        </div>
      </main>
    );
  }

  // Show the request form
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>Forgot your password?</h1>
        <p className={styles.subtitle}>
          Enter your email and we'll send you a reset link.
        </p>

        {errorMessage && <div className={styles.errorBox}>{errorMessage}</div>}

        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="email" className={styles.label}>
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isLoading}
              className="form-input"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className={styles.submitButton}
          >
            {isLoading ? "Sending..." : "Send reset link"}
          </button>
        </form>

        <p className={styles.footer}>
          Remember your password?{" "}
          <Link to="/auth" className={styles.footerLink}>
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
