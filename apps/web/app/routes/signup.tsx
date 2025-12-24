import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import type { MetaFunction } from "react-router";
import { signUp, signIn } from "~/lib/auth-client";
import styles from "~/styles/signup.module.css";

export const meta: MetaFunction = () => [
  { title: "Sign Up | Docket" },
  { name: "description", content: "Create your Docket account" },
];

export default function SignupPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const inviteCode = searchParams.get("invite");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function getRedirectUrl(): string {
    if (inviteCode) {
      return `/invite/${inviteCode}`;
    }
    return "/dashboard";
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    await signUp.email(
      { name, email, password },
      {
        onSuccess: () => {
          navigate(getRedirectUrl());
        },
        onError: (ctx) => {
          const message = ctx.error.message || "Failed to create account";
          setError(message);
          setLoading(false);
        },
      }
    );
  }

  function handleGoogleSignIn() {
    signIn.social({
      provider: "google",
      callbackURL: getRedirectUrl(),
    });
  }

  function handleAppleSignIn() {
    signIn.social({
      provider: "apple",
      callbackURL: getRedirectUrl(),
    });
  }

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1>Create your account</h1>
        <p className={styles.subtitle}>Sign up to get started with Docket.</p>

        {error && <div className={styles.errorBox}>{error}</div>}

        <form onSubmit={handleSubmit}>
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
              disabled={loading}
              className={styles.input}
            />
          </div>

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
              minLength={8}
              disabled={loading}
              className={styles.input}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={styles.submitButton}
          >
            {loading ? "Creating account..." : "Sign up"}
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
            Continue with Google
          </button>

          <button
            type="button"
            onClick={handleAppleSignIn}
            disabled={loading}
            className={styles.appleButton}
          >
            Continue with Apple
          </button>
        </div>

        <p className={styles.footer}>
          Already have an account?{" "}
          <Link to="/login" className={styles.footerLink}>
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
