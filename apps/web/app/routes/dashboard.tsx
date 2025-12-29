import { useState } from "react";
import { redirect, useRevalidator } from "react-router";
import type { Route } from "./+types/dashboard";
import { apiFetch, ENDPOINTS } from "~/lib/api";
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

/* ==========================================================================
   Types & Constants
   ========================================================================== */

interface FormData {
  orgType: string;
  name: string;
  firmSize: string;
  jurisdictions: string[];
  practiceAreas: string[];
}

const INITIAL_FORM_DATA: FormData = {
  orgType: "",
  name: "",
  firmSize: "",
  jurisdictions: [],
  practiceAreas: [],
};

const WIZARD_STEPS = [
  { title: "Firm Type", subtitle: "What type of firm are you creating?" },
  { title: "Basic Information", subtitle: "Tell us about your firm" },
  { title: "Jurisdictions", subtitle: "Select the states where you practice" },
  { title: "Practice Areas", subtitle: "Select your areas of practice" },
];

/* ==========================================================================
   Loader
   ========================================================================== */

export async function loader({ request, context }: Route.LoaderArgs) {
  const cookie = request.headers.get("cookie") || "";

  // Check if user is authenticated
  const sessionResponse = await apiFetch(
    context,
    ENDPOINTS.auth.session,
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
  let orgMembership: OrgMembership | null = null;
  const orgResponse = await apiFetch(context, ENDPOINTS.user.org, cookie);
  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) {
      orgMembership = orgData;
    }
  }

  return { user: sessionData.user, org: orgMembership };
}

/* ==========================================================================
   Component
   ========================================================================== */

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;
  const revalidator = useRevalidator();

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<FormData>(INITIAL_FORM_DATA);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* --------------------------------------------------------------------------
     Modal Handlers
     -------------------------------------------------------------------------- */

  function openModal() {
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setCurrentStep(1);
    setFormData(INITIAL_FORM_DATA);
    setError(null);
    setIsSubmitting(false);
  }

  function handleOverlayClick() {
    closeModal();
  }

  function handleModalContentClick(event: React.MouseEvent) {
    // Prevent clicks inside the modal from closing it
    event.stopPropagation();
  }

  /* --------------------------------------------------------------------------
     Form Handlers
     -------------------------------------------------------------------------- */

  function updateFormField<K extends keyof FormData>(
    field: K,
    value: FormData[K]
  ) {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  }

  function toggleArrayField(
    field: "jurisdictions" | "practiceAreas",
    id: string
  ) {
    setFormData((prev) => {
      const currentValues = prev[field];
      const isSelected = currentValues.includes(id);

      if (isSelected) {
        // Remove from array
        return {
          ...prev,
          [field]: currentValues.filter((item) => item !== id),
        };
      } else {
        // Add to array
        return {
          ...prev,
          [field]: [...currentValues, id],
        };
      }
    });
  }

  /* --------------------------------------------------------------------------
     Step Navigation
     -------------------------------------------------------------------------- */

  function canProceedToNextStep(): boolean {
    switch (currentStep) {
      case 1:
        return formData.orgType !== "";
      case 2:
        return formData.name.trim() !== "" && formData.firmSize !== "";
      case 3:
        return formData.jurisdictions.length > 0;
      case 4:
        return formData.practiceAreas.length > 0;
      default:
        return false;
    }
  }

  function goToNextStep() {
    setCurrentStep((prev) => prev + 1);
  }

  function goToPreviousStep() {
    setCurrentStep((prev) => prev - 1);
  }

  /* --------------------------------------------------------------------------
     Form Submission
     -------------------------------------------------------------------------- */

  async function handleSubmit() {
    if (!canProceedToNextStep()) {
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_URL}${ENDPOINTS.org.base}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: formData.name.trim(),
          firmSize: formData.firmSize,
          jurisdictions: formData.jurisdictions,
          practiceTypes: formData.practiceAreas,
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to create firm");
      }

      closeModal();
      revalidator.revalidate();
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Something went wrong");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  /* --------------------------------------------------------------------------
     Render Helpers
     -------------------------------------------------------------------------- */

  function getProgressStepClass(stepNumber: number): string {
    if (stepNumber === currentStep) {
      return "modal-progress-step active";
    }
    if (stepNumber < currentStep) {
      return "modal-progress-step completed";
    }
    return "modal-progress-step";
  }

  function getOptionCardClass(isSelected: boolean): string {
    if (isSelected) {
      return "modal-option-card selected";
    }
    return "modal-option-card";
  }

  function getSizeCardClass(isSelected: boolean): string {
    if (isSelected) {
      return "modal-size-card selected";
    }
    return "modal-size-card";
  }

  function getCheckboxItemClass(isSelected: boolean): string {
    if (isSelected) {
      return "modal-checkbox-item selected";
    }
    return "modal-checkbox-item";
  }

  /* --------------------------------------------------------------------------
     Render
     -------------------------------------------------------------------------- */

  const currentStepInfo = WIZARD_STEPS[currentStep - 1];
  const isLastStep = currentStep === 4;
  const canProceed = canProceedToNextStep();

  return (
    <AppLayout org={org} currentPath="/dashboard">
      <PageLayout title="Dashboard" subtitle={`Welcome back, ${user.name}`}>
        {/* Show onboarding section if user has no org */}
        {org === null && (
          <section className="section">
            <h2 className="text-title-3">Get Started</h2>
            <div className="info-card">
              <div>
                <h3 className="text-headline">Your firm</h3>
                <p className="text-secondary">
                  You&apos;re not part of a firm yet. Create one to start using
                  Docket, or wait for an invitation.
                </p>
              </div>
              <button onClick={openModal} className="btn btn-sm btn-primary">
                Create firm
              </button>
            </div>
          </section>
        )}
      </PageLayout>

      {/* Create Firm Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={handleOverlayClick}>
          <div className="modal-content" onClick={handleModalContentClick}>
            {/* Progress indicator */}
            <div className="modal-header">
              <div className="modal-progress">
                {[1, 2, 3, 4].map((stepNumber) => (
                  <div key={stepNumber} className="modal-progress-item">
                    <div className={getProgressStepClass(stepNumber)} />
                  </div>
                ))}
              </div>
            </div>

            {/* Step content */}
            <div className="modal-body">
              <h2 className="text-title-3">{currentStepInfo.title}</h2>
              <p className="text-secondary text-callout">
                {currentStepInfo.subtitle}
              </p>

              {error && <div className="alert alert-error">{error}</div>}

              {/* Step 1: Organization Type */}
              {currentStep === 1 && (
                <div className="modal-option-grid">
                  {ORGANIZATION_TYPES.map((orgType) => (
                    <button
                      key={orgType.id}
                      type="button"
                      className={getOptionCardClass(
                        formData.orgType === orgType.id
                      )}
                      onClick={() => updateFormField("orgType", orgType.id)}
                    >
                      {orgType.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Step 2: Basic Information */}
              {currentStep === 2 && (
                <>
                  <div className="form-group">
                    <label className="form-label" htmlFor="orgName">
                      Firm Name
                    </label>
                    <input
                      id="orgName"
                      type="text"
                      className="form-input"
                      value={formData.name}
                      onChange={(e) => updateFormField("name", e.target.value)}
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
                          className={getSizeCardClass(
                            formData.firmSize === size.id
                          )}
                          onClick={() => updateFormField("firmSize", size.id)}
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

              {/* Step 3: Jurisdictions */}
              {currentStep === 3 && (
                <div className="modal-body-scroll">
                  <div className="modal-checkbox-grid">
                    {US_STATES.map((state) => {
                      const isSelected = formData.jurisdictions.includes(state);
                      return (
                        <label
                          key={state}
                          className={getCheckboxItemClass(isSelected)}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() =>
                              toggleArrayField("jurisdictions", state)
                            }
                            className="modal-checkbox-input"
                          />
                          <span className="text-subhead">{state}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Step 4: Practice Areas */}
              {currentStep === 4 && (
                <div className="modal-body-scroll">
                  <div className="modal-checkbox-grid-2col">
                    {PRACTICE_AREAS.map((area) => {
                      const isSelected = formData.practiceAreas.includes(
                        area.id
                      );
                      return (
                        <label
                          key={area.id}
                          className={getCheckboxItemClass(isSelected)}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() =>
                              toggleArrayField("practiceAreas", area.id)
                            }
                            className="modal-checkbox-input"
                          />
                          <span className="text-subhead">{area.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Modal actions */}
            <div className="modal-actions">
              {currentStep > 1 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-lg btn-lg-fit"
                  onClick={goToPreviousStep}
                >
                  Back
                </button>
              )}

              {isLastStep ? (
                <button
                  type="button"
                  className="btn btn-primary btn-lg btn-lg-fit"
                  onClick={handleSubmit}
                  disabled={!canProceed || isSubmitting}
                >
                  {isSubmitting ? "Creating..." : "Create Firm"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-lg btn-lg-fit"
                  onClick={goToNextStep}
                  disabled={!canProceed}
                >
                  Continue
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
