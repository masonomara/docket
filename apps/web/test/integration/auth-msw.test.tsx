import { describe, it, expect } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import AuthPage from "~/routes/auth";

const API_URL = "http://localhost:8787";

function renderAuth(route = "/auth") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthPage />
    </MemoryRouter>
  );
}

// Helper to get the submit button (not "Continue with Google")
function getSubmitButton() {
  return screen.getByRole("button", { name: /^continue$/i });
}

describe("AuthPage", () => {
  describe("email step", () => {
    it("renders email input and submit button", () => {
      renderAuth();

      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(getSubmitButton()).toBeInTheDocument();
    });

    it("shows Google sign-in option", () => {
      renderAuth();

      expect(
        screen.getByRole("button", { name: /continue with google/i })
      ).toBeInTheDocument();
    });
  });

  describe("existing user with password", () => {
    it("shows password field after email check", async () => {
      const user = userEvent.setup();
      renderAuth();

      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.click(getSubmitButton());

      await waitFor(() => {
        expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
      });

      expect(
        screen.getByRole("button", { name: /log in/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
    });
  });

  describe("new user signup", () => {
    it("shows signup form for new user", async () => {
      const user = userEvent.setup();

      server.use(
        http.post(`${API_URL}/api/check-email`, () => {
          return HttpResponse.json({ exists: false, hasPassword: false });
        })
      );

      renderAuth();

      await user.type(screen.getByLabelText(/email/i), "new@example.com");
      await user.click(getSubmitButton());

      await waitFor(() => {
        expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
      });

      expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /sign up/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/create your account/i)).toBeInTheDocument();
    });
  });

  describe("oauth-only user", () => {
    it("shows Google sign-in prompt for oauth user", async () => {
      const user = userEvent.setup();

      server.use(
        http.post(`${API_URL}/api/check-email`, () => {
          return HttpResponse.json({ exists: true, hasPassword: false });
        })
      );

      renderAuth();

      await user.type(screen.getByLabelText(/email/i), "google@example.com");
      await user.click(getSubmitButton());

      await waitFor(() => {
        expect(
          screen.getByText(/this account uses google sign-in/i)
        ).toBeInTheDocument();
      });

      expect(
        screen.getByRole("button", { name: /continue with google/i })
      ).toBeInTheDocument();
    });
  });

  describe("invitation flow", () => {
    it("pre-fills email from invitation", async () => {
      renderAuth("/auth?invitation=inv-123");

      await waitFor(() => {
        expect(
          screen.queryByText(/loading invitation/i)
        ).not.toBeInTheDocument();
      });

      const emailInput = screen.getByLabelText(/email/i) as HTMLInputElement;
      expect(emailInput.value).toBe("invite@example.com");
    });

    it("shows inviter info in subtitle", async () => {
      renderAuth("/auth?invitation=inv-123");

      await waitFor(() => {
        expect(screen.getByText(/admin user invited you/i)).toBeInTheDocument();
      });

      expect(screen.getByText(/test firm/i)).toBeInTheDocument();
    });
  });

  describe("error handling", () => {
    it("shows error message on API failure", async () => {
      const user = userEvent.setup();

      server.use(
        http.post(`${API_URL}/api/check-email`, () => {
          return new HttpResponse(null, { status: 500 });
        })
      );

      renderAuth();

      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.click(getSubmitButton());

      await waitFor(() => {
        expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
      });
    });
  });
});
