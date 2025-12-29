import { useState } from "react";
import { redirect, useRevalidator } from "react-router";
import type { Route } from "./+types/dashboard";
import { apiFetch } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import type { SessionResponse, OrgMembership } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";
import {
  ORGANIZATION_TYPES,
  FIRM_SIZES,
  US_STATES,
  PRACTICE_AREAS,
} from "~/lib/org-constants";

const STEPS = [
  {
    title: "Firm Type",
    subtitle: "What type of firm are you creating?",
  },
  { title: "Basic Information", subtitle: "Tell us about your firm" },
  { title: "Jurisdictions", subtitle: "Select the states where you practice" },
  { title: "Practice Areas", subtitle: "Select your areas of practice" },
];

type StepNumber = 1 | 2 | 3 | 4;

interface CreateOrgFormData {
  orgType: string;
  name: string;
  firmSize: string;
  jurisdictions: string[];
  practiceAreas: string[];
}

const INITIAL_FORM_DATA: CreateOrgFormData = {
  orgType: "",
  name: "",
  firmSize: "",
  jurisdictions: [],
  practiceAreas: [],
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const cookie = request.headers.get("cookie") || "";

  // Check if user is logged in
  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie
  );

  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }

  const sessionData = (await sessionResponse.json()) as SessionResponse | null;

  if (!sessionData?.user) {
    throw redirect("/auth");
  }

  // Fetch user's organization membership
  const orgResponse = await apiFetch(context, "/api/user/org", cookie);

  let orgMembership: OrgMembership | null = null;
  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) {
      orgMembership = orgData;
    }
  }

  return {
    user: sessionData.user,
    org: orgMembership,
  };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;
  const revalidator = useRevalidator();

  // Create org modal state
  const [showCreateOrgModal, setShowCreateOrgModal] = useState(false);
  const [step, setStep] = useState<StepNumber>(1);
  const [form, setForm] = useState<CreateOrgFormData>(INITIAL_FORM_DATA);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function resetModal() {
    setStep(1);
    setForm(INITIAL_FORM_DATA);
    setError(null);
    setIsSubmitting(false);
  }

  function handleCloseModal() {
    setShowCreateOrgModal(false);
    resetModal();
  }

  function updateField<K extends keyof CreateOrgFormData>(
    key: K,
    value: CreateOrgFormData[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleArrayField(
    field: "jurisdictions" | "practiceAreas",
    id: string
  ) {
    setForm((prev) => {
      const currentArray = prev[field];
      const isSelected = currentArray.includes(id);
      const newArray = isSelected
        ? currentArray.filter((item) => item !== id)
        : [...currentArray, id];
      return { ...prev, [field]: newArray };
    });
  }

  function canProceedToNextStep(): boolean {
    switch (step) {
      case 1:
        return form.orgType !== "";
      case 2:
        return form.name.trim() !== "" && form.firmSize !== "";
      case 3:
        return form.jurisdictions.length > 0;
      case 4:
        return form.practiceAreas.length > 0;
      default:
        return false;
    }
  }

  function goToPreviousStep() {
    if (step > 1) {
      setStep((prev) => (prev - 1) as StepNumber);
    }
  }

  function goToNextStep() {
    if (step < 4 && canProceedToNextStep()) {
      setStep((prev) => (prev + 1) as StepNumber);
    }
  }

  async function handleSubmit() {
    if (!canProceedToNextStep()) return;

    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_URL}/api/org`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: form.name.trim(),
          firmSize: form.firmSize,
          jurisdictions: form.jurisdictions,
          practiceTypes: form.practiceAreas,
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to create firm");
      }

      handleCloseModal();
      revalidator.revalidate();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  const currentStepConfig = STEPS[step - 1];

  return (
    <AppLayout user={user} org={org} currentPath="/dashboard">
      <PageLayout title="Dashboard" subtitle={`Welcome back, ${user.name}`}>
        {org === null ? (
          <section>
            <h2 className="text-title-3">Get Started</h2>
            <div className="info-card">
              <div>
                <h3 className="text-headline">Your firm</h3>
                <p className="text-secondary">
                  You&apos;re not part of a firm yet. Create one to start using
                  Docket, or wait for an invitation.
                </p>
              </div>
              <button
                onClick={() => setShowCreateOrgModal(true)}
                className="btn btn-sm btn-primary"
              >
                Create firm
              </button>
            </div>
          </section>
        ) : (
          <></>
        )}
      </PageLayout>

      {showCreateOrgModal && (
        <div className="modal-overlay" onClick={handleCloseModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-progress">
                {[
                  "Firm Type",
                  "Basic Info",
                  "Jurisdiction",
                  "Practice Areas",
                ].map((label, i) => {
                  const stepNumber = i + 1;
                  const isActive = stepNumber === step;
                  const isCompleted = stepNumber < step;
                  let stepClass = "modal-progress-step";
                  if (isActive) stepClass += " active";
                  else if (isCompleted) stepClass += " completed";
                  return (
                    <div key={stepNumber} className="modal-progress-item">
                      <div className={stepClass} />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="modal-body">
              <h2 className="text-title-3">{currentStepConfig.title}</h2>
              <p className="text-secondary text-callout">
                {currentStepConfig.subtitle}
              </p>

              {error && <div className="alert alert-error">{error}</div>}

              {step === 1 && (
                <div className="modal-option-grid">
                  {ORGANIZATION_TYPES.map((type) => (
                    <button
                      key={type.id}
                      type="button"
                      className={`modal-option-card${form.orgType === type.id ? " selected" : ""}`}
                      onClick={() => updateField("orgType", type.id)}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
              )}

              {step === 2 && (
                <>
                  <div className="form-group">
                    <label className="form-label" htmlFor="orgName">
                      Firm Name
                    </label>
                    <input
                      id="orgName"
                      type="text"
                      className="form-input"
                      value={form.name}
                      onChange={(e) => updateField("name", e.target.value)}
                      placeholder="Smith & Associates"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Firm Size</label>
                    <div className="modal-option-grid">
                      {FIRM_SIZES.map((size) => (
                        <button
                          key={size.id}
                          type="button"
                          className={`modal-size-card${form.firmSize === size.id ? " selected" : ""}`}
                          onClick={() => updateField("firmSize", size.id)}
                        >
                          <span className="text-callout">{size.label}</span>
                          <br />
                          <span className="text-footnote text-secondary">
                            {size.description}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {step === 3 && (
                <div className="modal-body-scroll">
                  <div className="modal-checkbox-grid">
                    {US_STATES.map((state) => (
                      <label
                        key={state}
                        className={`modal-checkbox-item${form.jurisdictions.includes(state) ? " selected" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={form.jurisdictions.includes(state)}
                          onChange={() =>
                            toggleArrayField("jurisdictions", state)
                          }
                          className="modal-checkbox-input"
                        />
                        <span className="text-subhead">{state}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {step === 4 && (
                <div className="modal-body-scroll">
                  <div className="modal-checkbox-grid-2col">
                    {PRACTICE_AREAS.map((area) => (
                      <label
                        key={area.id}
                        className={`modal-checkbox-item${form.practiceAreas.includes(area.id) ? " selected" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={form.practiceAreas.includes(area.id)}
                          onChange={() =>
                            toggleArrayField("practiceAreas", area.id)
                          }
                          className="modal-checkbox-input"
                        />
                        <span className="text-subhead">{area.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="modal-actions">
              {step > 1 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-lg btn-lg-fit"
                  onClick={goToPreviousStep}
                >
                  Back
                </button>
              )}
              {step < 4 ? (
                <button
                  type="button"
                  className="btn btn-primary btn-lg btn-lg-fit"
                  onClick={goToNextStep}
                  disabled={!canProceedToNextStep()}
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-lg btn-lg-fit"
                  onClick={handleSubmit}
                  disabled={!canProceedToNextStep() || isSubmitting}
                >
                  {isSubmitting ? "Creating..." : "Create Firm"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
