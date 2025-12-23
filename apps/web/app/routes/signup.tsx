import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import type { MetaFunction } from "react-router";
import { signUp, signIn } from "~/lib/auth-client";

export const meta: MetaFunction = () => {
  return [
    { title: "Sign Up | Docket" },
    { name: "description", content: "Create your Docket account" },
  ];
};

export default function SignupPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const inviteCode = searchParams.get("invite");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    await signUp.email(
      { name, email, password },
      {
        onSuccess: () => {
          // If there's a pending invitation, redirect to accept it
          if (inviteCode) {
            navigate(`/invite/${inviteCode}`);
          } else {
            navigate("/dashboard");
          }
        },
        onError: (ctx) => {
          setError(ctx.error.message || "Failed to create account");
          setLoading(false);
        },
      }
    );
  };

  const handleSocialSignIn = async (provider: "google" | "apple") => {
    setError(null);
    // Social sign-in redirects to provider, no need to handle response
    await signIn.social({
      provider,
      callbackURL: inviteCode ? `/invite/${inviteCode}` : "/dashboard",
    });
  };

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        maxWidth: "400px",
        margin: "0 auto",
      }}
    >
      <h1>Create your account</h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        Sign up to get started with Docket.
      </p>

      {error && (
        <div
          style={{
            padding: "0.75rem",
            background: "#fee",
            color: "#c00",
            borderRadius: "4px",
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "1rem" }}>
          <label
            htmlFor="name"
            style={{
              display: "block",
              marginBottom: "0.5rem",
              fontWeight: 500,
            }}
          >
            Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={loading}
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label
            htmlFor="email"
            style={{
              display: "block",
              marginBottom: "0.5rem",
              fontWeight: 500,
            }}
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </div>

        <div style={{ marginBottom: "1.5rem" }}>
          <label
            htmlFor="password"
            style={{
              display: "block",
              marginBottom: "0.5rem",
              fontWeight: 500,
            }}
          >
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
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            padding: "0.75rem",
            background: loading ? "#999" : "#000",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 500,
          }}
        >
          {loading ? "Creating account..." : "Sign up"}
        </button>
      </form>

      <div style={{ margin: "1.5rem 0", textAlign: "center", color: "#666" }}>
        or
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <button
          type="button"
          onClick={() => handleSocialSignIn("google")}
          disabled={loading}
          style={{
            width: "100%",
            padding: "0.75rem",
            background: "#fff",
            border: "1px solid #ccc",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          Continue with Google
        </button>
        <button
          type="button"
          onClick={() => handleSocialSignIn("apple")}
          disabled={loading}
          style={{
            width: "100%",
            padding: "0.75rem",
            background: "#000",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          Continue with Apple
        </button>
      </div>

      <p style={{ marginTop: "2rem", textAlign: "center", color: "#666" }}>
        Already have an account?{" "}
        <Link to="/login" style={{ color: "#000" }}>
          Log in
        </Link>
      </p>
    </main>
  );
}
