import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import type { MetaFunction } from "react-router";
import { signIn } from "~/lib/auth-client";
import styles from "~/styles/login.module.css";

export const meta: MetaFunction = () => [
  { title: "Log In | Docket" },
  { name: "description", content: "Log in to your Docket account" },
];

export default function LoginPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const redirectUrl = searchParams.get("redirect") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    console.log("Starting login...");

    try {
      const result = await signIn.email(
        { email, password },
        {
          onSuccess: () => {
            console.log("Login success callback, redirecting to:", redirectUrl);
            window.location.href = redirectUrl;
          },
          onError: (ctx) => {
            console.log("Login error callback:", ctx.error);
            const message = ctx.error.message || "Invalid email or password";
            setError(message);
            setLoading(false);
          },
        }
      );
      console.log("signIn.email returned:", result);
    } catch (err) {
      console.error("Login exception:", err);
      setError(err instanceof Error ? err.message : "Login failed");
      setLoading(false);
    }
  }

  function handleGoogleSignIn() {
    signIn.social({
      provider: "google",
      callbackURL: redirectUrl,
    });
  }

  function handleAppleSignIn() {
    signIn.social({
      provider: "apple",
      callbackURL: redirectUrl,
    });
  }

  return (
    <main className={styles.page}>
      <img
        src="/gradient-background.png"
        alt="Docket"
        height="100%"
        width="100%"
        style={{
          position: "absolute",
          top: "0px",
          left: "0px",
          right: "0px",
          bottom: "0px",
          zIndex: "-1",
        }}
      />

      <div className={styles.container}>
        <h1 className={styles.title}>Welcome back</h1>
        <p className={styles.subtitle}>We're excited to work with you again.</p>

        {error && <div className={styles.errorBox}>{error}</div>}

        <form onSubmit={handleSubmit}>
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
              disabled={loading}
              className={styles.input}
            />
          </div>

          <div className={styles.fieldGroupLast}>
            <label htmlFor="password" className={styles.label}>
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              className={styles.input}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={styles.submitButton}
          >
            {loading ? "Logging in..." : "Log in"}
          </button>
        </form>

        <div className={styles.divider}>or</div>

        <div className={styles.socialButtonContainer}>
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className={styles.googleButton}
          >
            <img
              src="/google-icon-button.png"
              alt="Docket"
              height="18px"
              width="18px"
            />
            Continue with Google
            <img
              src="/google-icon-button.png"
              alt="Docket"
              height="18px"
              width="18px"
              style={{ opacity: "0" }}
            />
          </button>

          <button
            type="button"
            onClick={handleAppleSignIn}
            disabled={loading}
            className={styles.appleButton}
          >
            <img
              src="/apple-icon-button.png"
              alt="Docket"
              height="18px"
              width="18px"
            />
            Continue with Apple
            <img
              src="/apple-icon-button.png"
              alt="Docket"
              height="18px"
              width="18px"
              style={{ opacity: "0" }}
            />
          </button>
        </div>

        <p className={styles.footer}>
          Need an account?{" "}
          <Link to="/signup" className={styles.footerLink}>
            Register
          </Link>
        </p>
      </div>
    </main>
  );
}
