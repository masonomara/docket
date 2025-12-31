import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router";
import type { MetaFunction } from "react-router";
import { verifyEmail } from "~/lib/auth-client";
import styles from "~/styles/auth.module.css";

export const meta: MetaFunction = () => [
  { title: "Verify Email | Docket" },
  { name: "description", content: "Verify your email address" },
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

type VerificationStatus = "loading" | "success" | "error";

/**
 * Email verification page - verifies the user's email using a token from the URL.
 */
export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const urlError = searchParams.get("error");

  const [status, setStatus] = useState<VerificationStatus>(
    urlError ? "error" : "loading"
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(
    urlError === "INVALID_TOKEN"
      ? "This verification link is invalid or has expired."
      : null
  );

  // Verify the email token on mount
  useEffect(() => {
    // Skip if there's already an error or no token
    if (!token || urlError) {
      setStatus("error");
      if (!errorMessage) {
        setErrorMessage("No verification token provided.");
      }
      return;
    }

    // Call the verification API
    verifyEmail({ query: { token } }).then((result) => {
      if (result.error) {
        setStatus("error");
        setErrorMessage(result.error.message || "Failed to verify email.");
      } else {
        setStatus("success");
      }
    });
  }, [token, urlError, errorMessage]);

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        {/* Loading State */}
        {status === "loading" && (
          <>
            <h1 className={styles.title}>Verifying your email...</h1>
            <p className={styles.subtitle}>Please wait a moment.</p>
          </>
        )}

        {/* Success State */}
        {status === "success" && (
          <>
            <h1 className={styles.title}>Email verified!</h1>
            <p className={styles.subtitle}>
              Your email has been verified. You can now access your account.
            </p>
            <Link
              to="/admin"
              className={styles.submitButton}
              style={linkButtonStyles}
            >
              Go to Admin Console
            </Link>
          </>
        )}

        {/* Error State */}
        {status === "error" && (
          <>
            <h1 className={styles.title}>Verification failed</h1>
            <p className={styles.subtitle}>{errorMessage}</p>
            <Link
              to="/auth"
              className={styles.submitButton}
              style={linkButtonStyles}
            >
              Sign In
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
