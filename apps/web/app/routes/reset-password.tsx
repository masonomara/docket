import { useState } from "react";
import { useSearchParams, Link } from "react-router";
import type { MetaFunction } from "react-router";
import { resetPassword } from "~/lib/auth-client";
import styles from "~/styles/auth.module.css";

export const meta: MetaFunction = () => [
  { title: "Reset Password | Docket" },
  {
    name: "description",
    content: "Set a new password for your Docket account",
  },
];

/**
 * Styles for making a Link look like a button.
 */
const linkButtonStyles: React.CSSProperties = {
  textAlign: "center",
  textDecoration: "none",
  display: "block",
  lineHeight: "40px",
};

/**
 * Reset password page - allows users to set a new password using a token.
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const urlError = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    urlError === "INVALID_TOKEN"
      ? "This reset link is invalid or has expired."
      : null
  );

  /**
   * Handles the password reset form submission.
   */
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);

    // Validate passwords match
    if (password !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    // Validate password length
    if (password.length < 8) {
      setErrorMessage("Password must be at least 8 characters.");
      return;
    }

    // Validate token exists
    if (!token) {
      setErrorMessage("Missing reset token.");
      return;
    }

    setIsLoading(true);

    const resetResult = await resetPassword({
      newPassword: password,
      token,
    });

    setIsLoading(false);

    if (resetResult.error) {
      setErrorMessage(resetResult.error.message || "Failed to reset password.");
    } else {
      setIsSuccess(true);
    }
  }

  // Show success message after password is reset
  if (isSuccess) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Password reset!</h1>
          <p className={styles.subtitle}>
            Your password has been updated. You can now log in with your new
            password.
          </p>
          <Link
            to="/auth"
            className={styles.submitButton}
            style={linkButtonStyles}
          >
            Sign In
          </Link>
        </div>
      </main>
    );
  }

  // Show error if token is invalid or missing
  const hasInvalidToken = urlError === "INVALID_TOKEN" || (!token && !urlError);

  if (hasInvalidToken) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <h1 className={styles.title}>Invalid reset link</h1>
          <p className={styles.subtitle}>
            This password reset link is invalid or has expired. Please request a
            new one.
          </p>
          <Link
            to="/forgot-password"
            className={styles.submitButton}
            style={linkButtonStyles}
          >
            Request new link
          </Link>
        </div>
      </main>
    );
  }

  // Show the reset form
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>Set new password</h1>
        <p className={styles.subtitle}>Enter your new password below.</p>

        {errorMessage && <div className={styles.errorBox}>{errorMessage}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-input">
            <label htmlFor="password" className={styles.label}>
              New Password
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
            />
          </div>

          <div className="form-input">
            <label htmlFor="confirmPassword" className={styles.label}>
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              disabled={isLoading}
              className={styles.input}
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className={styles.submitButton}
          >
            {isLoading ? "Resetting..." : "Reset password"}
          </button>
        </form>

        <p className={styles.footer}>
          <Link to="/auth" className={styles.footerLink}>
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
